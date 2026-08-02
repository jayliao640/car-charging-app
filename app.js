import { firebaseConfig } from "./config.js";

const BATTERY_KWH = 22;
const KWH_PER_PERCENT = BATTERY_KWH / 100;
const LOCAL_KEY = "carChargingRecordsV4";
const $ = id => document.getElementById(id);
const today = new Date().toISOString().slice(0,10);

let records = JSON.parse(localStorage.getItem(LOCAL_KEY) || "[]");
let currentUser = null;
let firebaseReady = false;
let db, auth, storage;
let firebaseFns = {};
let currentPhotoFile = null;
let editPhotoFile = null;
let editingId = null;
let deferredPrompt = null;

$("date").value = today;

function calcKwh(soc){
  const n = Number(soc);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? (100-n)*KWH_PER_PERCENT : 0;
}
function fmtTime(iso){
  if(!iso) return "-";
  return new Date(iso).toLocaleString("zh-TW");
}
function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
}
function saveLocal(){
  localStorage.setItem(LOCAL_KEY, JSON.stringify(records));
}
function configured(){
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);
}
function setStatus(text){
  $("syncStatus").textContent = text;
}
function setThisMonth(){
  const now = new Date();
  const first = new Date(now.getFullYear(),now.getMonth(),1);
  const last = new Date(now.getFullYear(),now.getMonth()+1,0);
  const fmt = d => {
    const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,"0"),day=String(d.getDate()).padStart(2,"0");
    return `${y}-${m}-${day}`;
  };
  $("startDate").value=fmt(first); $("endDate").value=fmt(last); render();
}
function filtered(){
  const s=$("startDate").value,e=$("endDate").value;
  return records.filter(r=>(!s||r.date>=s)&&(!e||r.date<=e)).sort((a,b)=>b.date.localeCompare(a.date)||String(b.createdAt).localeCompare(String(a.createdAt)));
}
function render(){
  const list=filtered();
  const total=list.reduce((sum,r)=>sum+Number(r.kwh||0),0);
  $("countStat").textContent=`${list.length} 次`;
  $("kwhStat").textContent=`${total.toFixed(2)} kWh`;
  $("avgStat").textContent=`${(list.length?total/list.length:0).toFixed(2)} kWh`;
  if(!list.length){$("tableWrap").innerHTML='<div class="empty">此日期區間尚無紀錄</div>';return;}
  $("tableWrap").innerHTML=`<table><thead><tr>
    <th>日期</th><th>充電前</th><th>用電度數</th><th>照片</th><th>備註</th><th>建立／修改</th><th>操作</th>
  </tr></thead><tbody>${list.map(r=>`<tr>
    <td>${escapeHtml(r.date)}</td>
    <td><span class="pill">${Number(r.soc)}%</span></td>
    <td><strong>${Number(r.kwh).toFixed(2)} kWh</strong></td>
    <td>${r.photoUrl?`<a href="${r.photoUrl}" target="_blank"><img class="thumb" src="${r.photoUrl}"></a>`:"-"}</td>
    <td>${escapeHtml(r.note||"-")}</td>
    <td><div class="meta">建立：${fmtTime(r.createdAt)}<br>修改：${r.updatedAt?fmtTime(r.updatedAt):"-"}</div></td>
    <td><button class="secondary" onclick="window.openEdit('${r.id}')">編輯</button>
        <button class="danger" onclick="window.removeRecord('${r.id}')">刪除</button></td>
  </tr>`).join("")}</tbody></table>`;
}
function resetForm(){
  $("date").value=today;$("soc").value="";$("note").value="";$("photo").value="";
  currentPhotoFile=null;$("preview").style.display="none";$("calcKwh").textContent="0.00 kWh";
}
async function compressImage(file, maxBytes = 1024 * 1024) {
  if (!file) return null;

  const bitmap = await createImageBitmap(file);
  let maxWidth = Math.min(1600, bitmap.width);
  let quality = 0.82;
  let blob = null;

  // 逐步降低 JPEG 品質；若仍超過 1MB，再縮小長寬。
  for (let round = 0; round < 12; round++) {
    const scale = Math.min(1, maxWidth / bitmap.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    blob = await new Promise(resolve =>
      canvas.toBlob(resolve, "image/jpeg", quality)
    );

    if (!blob) throw new Error("照片壓縮失敗");
    if (blob.size <= maxBytes) return blob;

    if (quality > 0.45) {
      quality -= 0.08;
    } else {
      maxWidth = Math.max(640, Math.round(maxWidth * 0.82));
      quality = 0.72;
    }
  }

  if (blob && blob.size <= maxBytes) return blob;
  throw new Error("照片無法壓縮至 1MB 以下，請改用較低解析度的照片");
}
async function uploadPhoto(file,id){
  if(!file || !firebaseReady || !currentUser) return "";
  setStatus("正在將照片壓縮至 1MB 以下…");
  const blob=await compressImage(file);
  setStatus("照片壓縮完成，正在上傳雲端…");
  const path=`shared/charging-photos/${id}.jpg`;
  const ref=firebaseFns.storageRef(storage,path);
  await firebaseFns.uploadBytes(ref,blob,{contentType:"image/jpeg"});
  const url = await firebaseFns.getDownloadURL(ref);
  setStatus(`照片已上傳（${(blob.size / 1024).toFixed(0)} KB）`);
  return url;
}
async function persistRecord(record){
  if(firebaseReady && currentUser){
    await firebaseFns.setDoc(firebaseFns.doc(db,"sharedRecords",record.id),record,{merge:true});
  }else{
    const idx=records.findIndex(r=>r.id===record.id);
    if(idx>=0) records[idx]=record; else records.unshift(record);
    saveLocal();
  }
}
async function loadCloud(){
  if(!firebaseReady||!currentUser)return;
  const snap=await firebaseFns.getDocs(firebaseFns.collection(db,"sharedRecords"));
  records=snap.docs.map(d=>({id:d.id,...d.data()}));
  saveLocal();render();setStatus("雲端同步正常｜所有使用者共用同一份紀錄");
}
async function initFirebase(){
  if(!configured()){
    setStatus("單機模式：資料只存在這台裝置");
    render();return;
  }
  try{
    const appMod=await import("https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js");
    const authMod=await import("https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js");
    const fsMod=await import("https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js");
    const stMod=await import("https://www.gstatic.com/firebasejs/12.16.0/firebase-storage.js");
    const app=appMod.initializeApp(firebaseConfig);
    auth=authMod.getAuth(app);db=fsMod.getFirestore(app);storage=stMod.getStorage(app);
    firebaseFns={...authMod,...fsMod,...stMod};
    firebaseReady=true;
    
    authMod.onAuthStateChanged(auth, async user => {
      currentUser = user;
      if (user) {
        await loadCloud();
      } else {
        try {
          await authMod.signInAnonymously(auth);
        } catch (err) {
          console.error(err);
          setStatus("匿名登入失敗，已切換為單機模式");
          records = JSON.parse(localStorage.getItem(LOCAL_KEY)||"[]");
          render();
        }
      }
    });
  }catch(e){
    console.error(e);setStatus("Firebase 連線失敗，已切換為單機模式");
  }
}
$("soc").oninput=()=>{$("calcKwh").textContent=calcKwh($("soc").value).toFixed(2)+" kWh"};
$("photo").onchange=e=>{
  currentPhotoFile=e.target.files[0]||null;
  if(currentPhotoFile){$("preview").src=URL.createObjectURL(currentPhotoFile);$("preview").style.display="block"}else $("preview").style.display="none";
};
$("resetBtn").onclick=resetForm;
$("saveBtn").onclick=async()=>{
  const date=$("date").value,soc=Number($("soc").value);
  if(!date)return alert("請選擇日期");
  if(!Number.isFinite(soc)||soc<0||soc>100)return alert("請輸入 0～100 的剩餘電量");
  $("saveBtn").disabled=true;$("saveBtn").textContent="儲存中…";
  try{
    const id=crypto.randomUUID?.()||String(Date.now());
    const photoUrl=await uploadPhoto(currentPhotoFile,id);
    const record={id,date,soc,kwh:Number(calcKwh(soc).toFixed(2)),note:$("note").value.trim(),photoUrl,createdAt:new Date().toISOString(),updatedAt:null};
    await persistRecord(record);
    if(firebaseReady&&currentUser)await loadCloud();else render();
    resetForm();alert("已儲存");
  }catch(e){console.error(e);alert("儲存失敗："+e.message)}
  finally{$("saveBtn").disabled=false;$("saveBtn").textContent="儲存紀錄"}
};
window.openEdit=id=>{
  const r=records.find(x=>x.id===id);if(!r)return;
  editingId=id;$("editDate").value=r.date;$("editSoc").value=r.soc;$("editNote").value=r.note||"";
  $("editKwh").textContent=calcKwh(r.soc).toFixed(2)+" kWh";
  $("editMeta").innerHTML=`建立：${fmtTime(r.createdAt)}<br>最後修改：${r.updatedAt?fmtTime(r.updatedAt):"尚未修改"}`;
  $("editPreview").style.display=r.photoUrl?"block":"none";if(r.photoUrl)$("editPreview").src=r.photoUrl;
  $("editPhoto").value="";editPhotoFile=null;$("editModal").classList.add("open");
};
$("editSoc").oninput=()=>{$("editKwh").textContent=calcKwh($("editSoc").value).toFixed(2)+" kWh"};
$("editPhoto").onchange=e=>{editPhotoFile=e.target.files[0]||null;if(editPhotoFile){$("editPreview").src=URL.createObjectURL(editPhotoFile);$("editPreview").style.display="block"}};
$("closeEditBtn").onclick=()=>$("editModal").classList.remove("open");
$("confirmEditBtn").onclick=async()=>{
  const r=records.find(x=>x.id===editingId);if(!r)return;
  const soc=Number($("editSoc").value);
  if(!$("editDate").value||!Number.isFinite(soc)||soc<0||soc>100)return alert("請確認日期及剩餘電量");
  $("confirmEditBtn").disabled=true;
  try{
    let photoUrl=r.photoUrl||"";
    if(editPhotoFile)photoUrl=await uploadPhoto(editPhotoFile,r.id);
    const updated={...r,date:$("editDate").value,soc,kwh:Number(calcKwh(soc).toFixed(2)),note:$("editNote").value.trim(),photoUrl,updatedAt:new Date().toISOString()};
    await persistRecord(updated);
    if(firebaseReady&&currentUser)await loadCloud();else render();
    $("editModal").classList.remove("open");alert("修改完成");
  }catch(e){alert("修改失敗："+e.message)}
  finally{$("confirmEditBtn").disabled=false}
};
window.removeRecord=async id=>{
  const r=records.find(x=>x.id===id);if(!r)return;
  if(!confirm(`確定刪除 ${r.date}、${Number(r.kwh).toFixed(2)} kWh 這筆紀錄？`))return;
  try{
    if(firebaseReady&&currentUser){
      await firebaseFns.deleteDoc(firebaseFns.doc(db,"sharedRecords",id));
      if(r.photoUrl){try{await firebaseFns.deleteObject(firebaseFns.storageRef(storage,`shared/charging-photos/${id}.jpg`))}catch(_){}}
      await loadCloud();
    }else{records=records.filter(x=>x.id!==id);saveLocal();render()}
  }catch(e){alert("刪除失敗："+e.message)}
};
$("filterBtn").onclick=render;$("thisMonthBtn").onclick=setThisMonth;
$("allBtn").onclick=()=>{$("startDate").value="";$("endDate").value="";render()};
$("exportBtn").onclick=()=>{
  const rows=[["日期","充電前電量(%)","用電度數(kWh)","備註","建立時間","最後修改時間"]];
  filtered().forEach(r=>rows.push([r.date,r.soc,r.kwh,r.note||"",fmtTime(r.createdAt),r.updatedAt?fmtTime(r.updatedAt):""]));
  const csv="\uFEFF"+rows.map(row=>row.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\n");
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));a.download="汽車充電紀錄.csv";a.click();URL.revokeObjectURL(a.href);
};
window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();deferredPrompt=e;$("installBtn").style.display="inline-block"});
$("installBtn").onclick=async()=>{if(deferredPrompt){deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;$("installBtn").style.display="none"}};
if("serviceWorker"in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("./service-worker.js"));
setThisMonth();initFirebase();
