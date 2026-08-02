import { firebaseConfig } from "./config.js";

const $ = id => document.getElementById(id);
const today = new Date().toISOString().slice(0,10);
const LOCAL_DEFAULT_VEHICLE_KEY = "chargingDefaultVehicleId";
const PHOTO_DB = "ChargingPhotoDB";
const PHOTO_STORE = "photos";

let db, auth, f = {};
let firebaseReady = false;
let records = [];
let vehicles = [];
let currentPhotoFile = null;
let editPhotoFile = null;
let editingRecordId = null;
let editingVehicleId = null;
let deferredPrompt = null;

$("date").value = today;

function configured(){
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);
}
function status(text){ if($("syncStatus")) $("syncStatus").textContent = text; }
function escapeHtml(s){ return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m])); }
function fmtTime(iso){ return iso ? new Date(iso).toLocaleString("zh-TW") : "-"; }
function getVehicle(id){ return vehicles.find(v=>v.id===id); }
function getDefaultVehicleId(){ return localStorage.getItem(LOCAL_DEFAULT_VEHICLE_KEY) || "BQH-8307"; }
function setDefaultVehicleId(id){ localStorage.setItem(LOCAL_DEFAULT_VEHICLE_KEY,id); }
function calcKwh(soc, vehicleId){
  const v = getVehicle(vehicleId);
  const n = Number(soc);
  if(!v || !Number.isFinite(n) || n<0 || n>100) return 0;
  return (100-n) * Number(v.batteryKwh) / 100;
}
function updateMainCalc(){
  const vid=$("vehicleSelect").value, soc=$("soc").value, v=getVehicle(vid);
  $("calcKwh").textContent=calcKwh(soc,vid).toFixed(2)+" kWh";
  $("formulaHint").textContent=v ? `公式：（100 − ${soc||0}%）× ${Number(v.batteryKwh)} kWh ÷ 100` : "請先新增車輛";
}
function updateEditCalc(){
  $("editKwh").textContent=calcKwh($("editSoc").value,$("editVehicle").value).toFixed(2)+" kWh";
}
function setThisMonth(){
  const now=new Date(), y=now.getFullYear(), m=now.getMonth();
  const fmt=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  $("startDate").value=fmt(new Date(y,m,1));
  $("endDate").value=fmt(new Date(y,m+1,0));
  renderRecords();
}
function filteredRecords(){
  const s=$("startDate").value,e=$("endDate").value,v=$("filterVehicle").value;
  return records.filter(r=>(!s||r.date>=s)&&(!e||r.date<=e)&&(!v||r.vehicleId===v))
    .sort((a,b)=>b.date.localeCompare(a.date)||String(b.createdAt).localeCompare(String(a.createdAt)));
}
async function openPhotoDb(){
  return await new Promise((resolve,reject)=>{
    const req=indexedDB.open(PHOTO_DB,1);
    req.onupgradeneeded=()=>{ if(!req.result.objectStoreNames.contains(PHOTO_STORE)) req.result.createObjectStore(PHOTO_STORE); };
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  });
}
async function putLocalPhoto(id,blob){
  const pdb=await openPhotoDb();
  await new Promise((resolve,reject)=>{
    const tx=pdb.transaction(PHOTO_STORE,"readwrite");
    tx.objectStore(PHOTO_STORE).put(blob,id);
    tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);
  });
  pdb.close();
}
async function getLocalPhoto(id){
  const pdb=await openPhotoDb();
  const result=await new Promise((resolve,reject)=>{
    const tx=pdb.transaction(PHOTO_STORE,"readonly");
    const req=tx.objectStore(PHOTO_STORE).get(id);
    req.onsuccess=()=>resolve(req.result||null); req.onerror=()=>reject(req.error);
  });
  pdb.close(); return result;
}
async function deleteLocalPhoto(id){
  const pdb=await openPhotoDb();
  await new Promise((resolve,reject)=>{
    const tx=pdb.transaction(PHOTO_STORE,"readwrite");
    tx.objectStore(PHOTO_STORE).delete(id);
    tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);
  });
  pdb.close();
}
async function compressImage(file,maxBytes=1024*1024){
  if(!file) return null;
  const bitmap=await createImageBitmap(file);
  let maxWidth=Math.min(1600,bitmap.width), quality=.82, blob=null;
  for(let i=0;i<12;i++){
    const scale=Math.min(1,maxWidth/bitmap.width);
    const canvas=document.createElement("canvas");
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));
    canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    canvas.getContext("2d").drawImage(bitmap,0,0,canvas.width,canvas.height);
    blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",quality));
    if(!blob) throw new Error("照片壓縮失敗");
    if(blob.size<=maxBytes) return blob;
    if(quality>.45) quality-=.08; else {maxWidth=Math.max(640,Math.round(maxWidth*.82));quality=.72;}
  }
  throw new Error("照片無法壓縮至 1MB 以下");
}
async function hasLocalPhoto(id){ return Boolean(await getLocalPhoto(id)); }
function populateVehicleSelects(){
  const sorted=[...vehicles].sort((a,b)=>a.plate.localeCompare(b.plate));
  const opts=sorted.map(v=>`<option value="${escapeHtml(v.id)}">${escapeHtml(v.plate)}${v.name?`｜${escapeHtml(v.name)}`:""}｜${Number(v.batteryKwh)} kWh</option>`).join("");
  $("vehicleSelect").innerHTML=opts;
  $("editVehicle").innerHTML=opts;
  $("filterVehicle").innerHTML='<option value="">全部車輛</option>'+opts;
  const def=getDefaultVehicleId();
  if(sorted.some(v=>v.id===def)) $("vehicleSelect").value=def;
  else if(sorted[0]) $("vehicleSelect").value=sorted[0].id;
  updateMainCalc();
}
async function renderRecords(){
  const list=filteredRecords(),total=list.reduce((s,r)=>s+Number(r.kwh||0),0),avg=list.length?total/list.length:0;
  $("countStat").textContent=`${list.length} 次`;
  $("kwhStat").textContent=`${total.toFixed(2)} kWh`;
  $("avgStat").textContent=`${avg.toFixed(2)} kWh`;
  $("rangeTotalKwh").textContent=`${total.toFixed(2)} kWh`;
  $("rangeSummaryText").textContent=`${list.length} 次充電｜平均 ${avg.toFixed(2)} kWh／次`;
  if(!list.length){$("tableWrap").innerHTML='<div class="empty">此條件下尚無充電紀錄</div>';return;}
  const rows=[];
  for(const r of list){
    const v=getVehicle(r.vehicleId);
    const localPhoto=await getLocalPhoto(r.id);
    const localUrl=localPhoto?URL.createObjectURL(localPhoto):"";
    let photoCell="-";
    if(localPhoto) photoCell=`<a href="${localUrl}" target="_blank"><img class="thumb" src="${localUrl}"></a><div class="meta">本機照片</div>`;
    else if(r.photoAttached) photoCell='<div class="meta">照片僅保存在原始裝置</div>';
    rows.push(`<tr>
      <td>${escapeHtml(r.date)}</td>
      <td><span class="vehicle-pill"><span class="dot"></span>${escapeHtml(v?.plate||r.vehiclePlate||"-")}</span></td>
      <td><span class="pill">${Number(r.soc)}%</span></td>
      <td><strong>${Number(r.kwh).toFixed(2)} kWh</strong></td>
      <td>${photoCell}</td>
      <td>${escapeHtml(r.note||"-")}</td>
      <td><div class="meta">建立：${fmtTime(r.createdAt)}<br>修改：${r.updatedAt?fmtTime(r.updatedAt):"-"}</div></td>
      <td><button class="secondary" onclick="window.openEdit('${r.id}')">編輯</button>
      <button class="danger" onclick="window.removeRecord('${r.id}')">刪除</button></td>
    </tr>`);
  }
  $("tableWrap").innerHTML=`<table><thead><tr><th>日期</th><th>車輛</th><th>充電前</th><th>用電</th><th>照片</th><th>備註</th><th>建立／修改</th><th>操作</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}
function renderVehicleList(){
  $("vehicleList").innerHTML=vehicles.sort((a,b)=>a.plate.localeCompare(b.plate)).map(v=>`
    <div class="vehicle-row">
      <div><strong>${escapeHtml(v.plate)}${getDefaultVehicleId()===v.id?" ⭐":""}</strong>
      <div class="sub">${escapeHtml(v.name||"未填車名")}｜${Number(v.batteryKwh)} kWh</div></div>
      <div class="actions">
        <button class="success" onclick="window.makeDefaultVehicle('${v.id}')">設為預設</button>
        <button class="secondary" onclick="window.editVehicle('${v.id}')">編輯</button>
        <button class="danger" onclick="window.deleteVehicle('${v.id}')">刪除</button>
      </div>
    </div>`).join("");
}
async function ensureDefaultVehicle(){
  const ref=f.doc(db,"sharedVehicles","BQH-8307");
  const snap=await f.getDoc(ref);
  if(!snap.exists()){
    await f.setDoc(ref,{plate:"BQH-8307",name:"RAV4 PHEV",batteryKwh:22,createdAt:new Date().toISOString()});
  }
}
async function loadCloud(){
  await ensureDefaultVehicle();
  const [vs,rs]=await Promise.all([
    f.getDocs(f.collection(db,"sharedVehicles")),
    f.getDocs(f.collection(db,"sharedRecords"))
  ]);
  vehicles=vs.docs.map(d=>({id:d.id,...d.data()}));
  records=rs.docs.map(d=>({id:d.id,...d.data()}));
  populateVehicleSelects(); renderVehicleList(); await renderRecords();
  status("雲端同步正常｜文字紀錄可跨 iPhone、Android、電腦同步");
}
async function initFirebase(){
  if(!configured()){status("Firebase 尚未設定");return;}
  try{
    const appMod=await import("https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js");
    const authMod=await import("https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js");
    const fsMod=await import("https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js");
    const app=appMod.initializeApp(firebaseConfig);
    auth=authMod.getAuth(app);db=fsMod.getFirestore(app);f={...authMod,...fsMod};firebaseReady=true;
    authMod.onAuthStateChanged(auth,async user=>{
      if(user) await loadCloud();
      else await authMod.signInAnonymously(auth);
    });
  }catch(e){console.error(e);status("Firebase 連線失敗："+e.message);}
}
function resetForm(){
  $("date").value=today;$("soc").value="";$("note").value="";$("photo").value="";
  currentPhotoFile=null;$("preview").style.display="none";updateMainCalc();
}
$("vehicleSelect").addEventListener("change",updateMainCalc);
$("soc").addEventListener("input",updateMainCalc);
$("soc").addEventListener("change",updateMainCalc);
$("photo").addEventListener("change",e=>{
  currentPhotoFile=e.target.files[0]||null;
  if(currentPhotoFile){$("preview").src=URL.createObjectURL(currentPhotoFile);$("preview").style.display="block"}else $("preview").style.display="none";
});
$("resetBtn").onclick=resetForm;
$("saveBtn").onclick=async()=>{
  if(!firebaseReady)return alert("Firebase 尚未連線");
  const vehicleId=$("vehicleSelect").value,date=$("date").value,soc=Number($("soc").value),v=getVehicle(vehicleId);
  if(!v)return alert("請先新增或選擇車輛");
  if(!date)return alert("請選擇日期");
  if(!Number.isFinite(soc)||soc<0||soc>100)return alert("請輸入 0～100 的剩餘電量");
  $("saveBtn").disabled=true;$("saveBtn").textContent="儲存中…";
  try{
    const id=(crypto.randomUUID&&crypto.randomUUID())||String(Date.now());
    let photoAttached=false;
    if(currentPhotoFile){
      status("正在壓縮並儲存本機照片…");
      const blob=await compressImage(currentPhotoFile);
      await putLocalPhoto(id,blob); photoAttached=true;
    }
    const record={id,vehicleId,vehiclePlate:v.plate,date,soc,kwh:Number(calcKwh(soc,vehicleId).toFixed(2)),note:$("note").value.trim(),photoAttached,createdAt:new Date().toISOString(),updatedAt:null};
    await f.setDoc(f.doc(db,"sharedRecords",id),record);
    resetForm();await loadCloud();alert("已儲存");
  }catch(e){console.error(e);alert("儲存失敗："+e.message)}
  finally{$("saveBtn").disabled=false;$("saveBtn").textContent="儲存紀錄"}
};
window.openEdit=async id=>{
  const r=records.find(x=>x.id===id);if(!r)return;
  editingRecordId=id;$("editVehicle").value=r.vehicleId;$("editDate").value=r.date;$("editSoc").value=r.soc;$("editNote").value=r.note||"";
  const p=await getLocalPhoto(id);$("editPreview").style.display=p?"block":"none";if(p)$("editPreview").src=URL.createObjectURL(p);
  $("removeLocalPhotoBtn").style.display=p?"inline-block":"none";$("editPhoto").value="";editPhotoFile=null;updateEditCalc();
  $("editMeta").innerHTML=`建立：${fmtTime(r.createdAt)}<br>最後修改：${r.updatedAt?fmtTime(r.updatedAt):"尚未修改"}`;
  $("editModal").classList.add("open");
};
$("editVehicle").addEventListener("change",updateEditCalc);
$("editSoc").addEventListener("input",updateEditCalc);
$("editPhoto").addEventListener("change",e=>{editPhotoFile=e.target.files[0]||null;if(editPhotoFile){$("editPreview").src=URL.createObjectURL(editPhotoFile);$("editPreview").style.display="block"}});
$("closeEditBtn").onclick=()=>$("editModal").classList.remove("open");
$("removeLocalPhotoBtn").onclick=async()=>{if(!editingRecordId)return;if(confirm("確定刪除這台裝置上的照片？")){await deleteLocalPhoto(editingRecordId);$("editPreview").style.display="none";$("removeLocalPhotoBtn").style.display="none";}};
$("confirmEditBtn").onclick=async()=>{
  const r=records.find(x=>x.id===editingRecordId);if(!r)return;
  const vehicleId=$("editVehicle").value,date=$("editDate").value,soc=Number($("editSoc").value),v=getVehicle(vehicleId);
  if(!v||!date||!Number.isFinite(soc)||soc<0||soc>100)return alert("請確認車輛、日期與剩餘電量");
  $("confirmEditBtn").disabled=true;
  try{
    let photoAttached=r.photoAttached||false;
    if(editPhotoFile){const blob=await compressImage(editPhotoFile);await putLocalPhoto(r.id,blob);photoAttached=true;}
    else if(!(await hasLocalPhoto(r.id)) && !r.photoAttached) photoAttached=false;
    const updated={...r,vehicleId,vehiclePlate:v.plate,date,soc,kwh:Number(calcKwh(soc,vehicleId).toFixed(2)),note:$("editNote").value.trim(),photoAttached,updatedAt:new Date().toISOString()};
    await f.setDoc(f.doc(db,"sharedRecords",r.id),updated,{merge:true});
    $("editModal").classList.remove("open");await loadCloud();alert("修改完成");
  }catch(e){alert("修改失敗："+e.message)}
  finally{$("confirmEditBtn").disabled=false}
};
window.removeRecord=async id=>{
  const r=records.find(x=>x.id===id);if(!r)return;
  if(!confirm(`確定刪除 ${r.date}、${Number(r.kwh).toFixed(2)} kWh 這筆紀錄？`))return;
  await f.deleteDoc(f.doc(db,"sharedRecords",id));await deleteLocalPhoto(id);await loadCloud();
};
$("filterBtn").onclick=renderRecords;$("thisMonthBtn").onclick=setThisMonth;
$("allBtn").onclick=()=>{$("startDate").value="";$("endDate").value="";renderRecords()};
$("filterVehicle").onchange=renderRecords;
$("exportBtn").onclick=()=>{
  const rows=[["日期","車號","車名","充電前電量(%)","用電度數(kWh)","備註","建立時間","最後修改時間"]];
  filteredRecords().forEach(r=>{const v=getVehicle(r.vehicleId);rows.push([r.date,v?.plate||r.vehiclePlate||"",v?.name||"",r.soc,r.kwh,r.note||"",fmtTime(r.createdAt),r.updatedAt?fmtTime(r.updatedAt):""])});
  const csv="\uFEFF"+rows.map(row=>row.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\n");
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));a.download="汽車充電紀錄.csv";a.click();URL.revokeObjectURL(a.href);
};
$("vehicleManageBtn").onclick=()=>{$("vehicleModal").classList.add("open");renderVehicleList()};
$("closeVehicleBtn").onclick=()=>$("vehicleModal").classList.remove("open");
$("cancelVehicleEditBtn").onclick=()=>{editingVehicleId=null;$("vehicleFormTitle").textContent="新增車輛";$("saveVehicleBtn").textContent="新增車輛";$("cancelVehicleEditBtn").style.display="none";$("vehiclePlateInput").value="";$("vehicleNameInput").value="";$("vehicleBatteryInput").value=""};
window.makeDefaultVehicle=id=>{setDefaultVehicleId(id);populateVehicleSelects();renderVehicleList()};
window.editVehicle=id=>{const v=getVehicle(id);if(!v)return;editingVehicleId=id;$("vehicleFormTitle").textContent="編輯車輛";$("saveVehicleBtn").textContent="儲存修改";$("cancelVehicleEditBtn").style.display="inline-block";$("vehiclePlateInput").value=v.plate;$("vehicleNameInput").value=v.name||"";$("vehicleBatteryInput").value=v.batteryKwh};
window.deleteVehicle=async id=>{
  if(id==="BQH-8307")return alert("預設車輛 BQH-8307 不可刪除");
  if(records.some(r=>r.vehicleId===id))return alert("此車輛已有充電紀錄，請先保留或移轉紀錄後再刪除");
  if(!confirm("確定刪除此車輛？"))return;
  await f.deleteDoc(f.doc(db,"sharedVehicles",id));if(getDefaultVehicleId()===id)setDefaultVehicleId("BQH-8307");await loadCloud();
};
$("saveVehicleBtn").onclick=async()=>{
  const plate=$("vehiclePlateInput").value.trim().toUpperCase(),name=$("vehicleNameInput").value.trim(),batteryKwh=Number($("vehicleBatteryInput").value);
  if(!plate)return alert("請輸入車號");if(!Number.isFinite(batteryKwh)||batteryKwh<=0)return alert("請輸入正確電池容量");
  const id=editingVehicleId||plate;
  if(!editingVehicleId && vehicles.some(v=>v.id===id))return alert("此車號已存在");
  await f.setDoc(f.doc(db,"sharedVehicles",id),{plate,name,batteryKwh,updatedAt:new Date().toISOString(),...(editingVehicleId?{}:{createdAt:new Date().toISOString()})},{merge:true});
  $("cancelVehicleEditBtn").click();await loadCloud();
};
window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();deferredPrompt=e;$("installBtn").style.display="inline-block"});
$("installBtn").onclick=async()=>{if(deferredPrompt){deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;$("installBtn").style.display="none"}};
if("serviceWorker"in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("./service-worker.js"));
window.addEventListener("error",e=>status("程式錯誤："+e.message));
setThisMonth();initFirebase();
