import {validatePublicAudio,validDriveId,validResourceKey} from './media.js';
import {receivedDay} from './calendar.js';
// Account binding is private IndexedDB state, never a public build setting.
export let ACCOUNT = '';
export function configureAccount(value) {
  const email=String(value||'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw new AppError('설정에서 보관할 Google 계정 이메일을 입력해 주세요.','account');
  ACCOUNT=email;return email;
}
export const APP = 'atelier-francais-v1';
export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const MAX_JSON = 5*1024*1024;
export class AppError extends Error { constructor(message,code='validation') {super(message);this.code=code;} }
const fail = (message) => {throw new AppError(message);};
function str(x,label,max=10000) {if(typeof x!=='string'||!x.trim()||x.length>max)fail(label+'을 확인해 주세요.');return x.normalize('NFC');}
function arr(x,label,max=200) {if(!Array.isArray(x)||!x.length||x.length>max)fail(label+' 목록을 확인해 주세요.');return x;}
export function validateLesson(x) {
  if(!x || x.schemaVersion!==1)fail('수업 schemaVersion은 1이어야 합니다.');
  if(!ACCOUNT)fail('설정에서 보관 계정을 먼저 저장해 주세요.');
  const source=x.source;
  if(!source || source.kind!=='gmail' || source.account!==ACCOUNT || !/^[a-f0-9]{8,64}$/.test(source.messageId||'') || typeof source.sender!=='string' || source.sender.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(source.sender))fail('지정한 수업 메일의 계정·발신자·messageId를 확인해 주세요.');
  if(!Number.isSafeInteger(x.revision)||x.revision<1)fail('revision은 1 이상의 정수여야 합니다.');
  const id='gmail:'+source.account+':'+source.messageId;
  if(x.id!==id)fail('수업 id가 원본 메일과 다릅니다.');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(x.date||'') || !Number.isFinite(Date.parse(source.receivedAt)))fail('수업 날짜를 확인해 주세요.');
  if(source.verified!==true || !/^[a-f0-9]{64}$/.test(source.attachmentSha256||''))fail('원본 확인과 PNG SHA-256이 필요합니다.');
  const pair=(p)=>({fr:str(p?.fr,'프랑스어'),ko:str(p?.ko,'번역')});
  const result={schemaVersion:1,id,revision:x.revision,title:str(x.title,'제목',160),date:x.date,source:{kind:'gmail',account:ACCOUNT,messageId:source.messageId,sender:source.sender,receivedAt:source.receivedAt,subject:str(source.subject,'메일 제목',200),attachmentName:str(source.attachmentName,'첨부 이름',200),attachmentSha256:source.attachmentSha256,verified:true},passage:arr(x.passage,'본문',30).map(pair),vocabulary:arr(x.vocabulary,'어휘',100).map(v=>({fr:str(v?.fr,'어휘',150),ko:str(v?.ko,'어휘 뜻',300)})),examples:arr(x.examples,'예문',100).map(pair),audio:validatePublicAudio(x.audio)};
  if(x.date!==receivedDay(source.receivedAt))fail('수업 날짜는 메일을 받은 한국 날짜와 같아야 합니다.');
  if(source.publicImageFileId){if(!validDriveId(source.publicImageFileId))fail('공개 원본 PNG ID를 확인해 주세요.');result.source.publicImageFileId=source.publicImageFileId;if(source.publicImageResourceKey){if(!validResourceKey(source.publicImageResourceKey))fail('공개 원본 PNG 링크를 확인해 주세요.');result.source.publicImageResourceKey=source.publicImageResourceKey;}}
  return result;
}
export function parseImport(text) {
  if(typeof text!=='string'||text.length>MAX_JSON)fail('JSON은 5MB 이하로 가져와 주세요.');
  let x;try{x=JSON.parse(text);}catch{fail('올바른 JSON 파일이 필요합니다.');}
  const values=x.schemaVersion===1&&Array.isArray(x.lessons)?x.lessons:[x];
  if(values.length>500)fail('한 번에 최대 500회차를 가져올 수 있습니다.');
  const lessons=values.map(validateLesson), ids=new Set();
  for(const l of lessons){if(ids.has(l.id))fail('같은 메일의 회차가 JSON 안에 중복되어 있습니다.');ids.add(l.id);}
  return lessons;
}
export function canonical(value) {
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
}
export async function sha256(value) {
  const bytes=typeof value==='string'?new TextEncoder().encode(value):value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export function lessonContent(l) {const {revision,...rest}=l;return canonical(rest);}
export function mergeLessons(existing,incoming,{updates=false,remote=false}={}) {
  const map=new Map(existing.map(l=>[l.id,l]));const report={added:0,updated:0,duplicate:0};
  for(const raw of incoming){const l=validateLesson(raw),old=map.get(l.id);
    if(!old){map.set(l.id,l);report.added++;continue;}
    if(lessonContent(old)===lessonContent(l)){report.duplicate++;if(l.revision>old.revision)map.set(l.id,l);continue;}
    if(remote&&l.revision<old.revision)continue;
    if(l.revision<=old.revision)throw new AppError('같은 회차의 revision '+l.revision+' 내용이 다릅니다. 기존 자료를 보존했습니다. 새 revision으로 확인해 주세요.','conflict');
    if(!updates)throw new AppError('수정된 회차입니다. 업데이트 내용을 확인한 뒤 적용해 주세요.','update');
    map.set(l.id,l);report.updated++;
  }
  return {lessons:[...map.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id)),report};
}
export function emptyState() {return {version:1,account:ACCOUNT,lessons:[],events:[],assets:[],drafts:{},savedDrafts:{},syncedLessons:{},catalogId:'',rootFolderId:'',recordsFolderId:'',sourceFolderId:'',dateFolderIds:{},lastSync:null,deviceId:crypto.randomUUID()};}
export function makeEvent(state,lessonId,type,payload={}) {return {schemaVersion:1,id:crypto.randomUUID(),deviceId:state.deviceId,lessonId,type,payload,at:new Date().toISOString()};}
export function validateEvent(e) {
  if(!e || e.schemaVersion!==1 || !/^[\w-]{16,80}$/.test(e.id||'') || !/^[\w-]{16,80}$/.test(e.deviceId||'') || !e.lessonId?.startsWith('gmail:'+ACCOUNT+':') || !['bookmark','complete','review','asset'].includes(e.type) || !Number.isFinite(Date.parse(e.at)) || !e.payload || typeof e.payload!=='object'||Array.isArray(e.payload))fail('학습 기록 형식을 확인해 주세요.');
  if(e.type==='bookmark'&&(typeof e.payload.saved!=='boolean'||typeof e.payload.fr!=='string'||typeof e.payload.ko!=='string'||e.payload.fr.length>10000||e.payload.ko.length>10000))fail('표현 저장 기록을 확인해 주세요.');
  if(e.type==='complete'&&typeof e.payload.completed!=='boolean')fail('필사 완료 기록을 확인해 주세요.');
  if(e.type==='review'&&(!Number.isInteger(e.payload.total)||!Number.isInteger(e.payload.correct)||e.payload.correct<0||e.payload.correct>e.payload.total||e.payload.total>100))fail('복습 기록을 확인해 주세요.');
  if(e.type==='asset'&&(!/^[\w-]{16,80}$/.test(e.payload.assetId||'')||!['canvas','photo'].includes(e.payload.kind)))fail('필사 파일 기록을 확인해 주세요.');
  return JSON.parse(JSON.stringify(e));
}
export function mergeEvents(existing,incoming) {
  const map=new Map(existing.map(e=>[e.id,e]));
  for(const raw of incoming){const e=validateEvent(raw);const old=map.get(e.id);if(old&&canonical({...old,synced:undefined})!==canonical({...e,synced:undefined}))throw new AppError('학습 기록 ID의 내용이 충돌했습니다. 두 기록을 보존해 주세요.','conflict');map.set(e.id,{...e,synced:old?.synced||raw.synced||false});}
  return [...map.values()].sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
}
export function latest(state,lessonId,type,match=()=>true) {return state.events.filter(e=>e.lessonId===lessonId&&e.type===type&&match(e)).sort((a,b)=>b.at.localeCompare(a.at)||b.id.localeCompare(a.id))[0];}
export function bookmarks(state) {const result=new Map();for(const e of [...state.events].sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id))){if(e.type==='bookmark')result.set(e.lessonId+'|'+e.payload.fr,e);}return [...result.values()].filter(e=>e.payload.saved);}
export function normalizeAnswer(s){return s.normalize('NFC').toLocaleLowerCase('fr').trim().replace(/[’‘]/g,"'").replace(/\s+/g,' ').replace(/[.!?]+$/,'');}
export function questions(lesson) {return [...lesson.vocabulary.map(v=>({kind:'recall',prompt:v.ko,answer:v.fr})),...lesson.examples.filter(p=>p.fr.includes('avec violence')).map(p=>({kind:'blank',prompt:p.fr.replace('avec violence','_____'),ko:p.ko,answer:'avec violence'}))].slice(0,6);}
export function pendingCount(state) {return state.events.filter(e=>!e.synced).length+state.assets.filter(a=>!a.driveId).length+state.lessons.filter(l=>state.syncedLessons[l.id]!==canonical(l)).length;}
export function pendingDraftCount(state){return Object.entries(state.drafts).filter(([id,strokes])=>strokes.length&&state.savedDrafts?.[id]!==canonical(strokes)).length;}
export function safeText(value) {return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
export function openRepository(indexedDB=globalThis.indexedDB) {
  let dbPromise;
  function db(){return dbPromise ||= new Promise((resolve,reject)=>{const request=indexedDB.open(APP,1);request.onupgradeneeded=()=>request.result.createObjectStore('cache');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
  return {
    async read(){const d=await db();return new Promise((resolve,reject)=>{const tx=d.transaction('cache','readonly');const req=tx.objectStore('cache').get('state');req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error);});},
    async write(state){const d=await db();return new Promise((resolve,reject)=>{const tx=d.transaction('cache','readwrite');tx.objectStore('cache').put(structuredClone(state),'state');tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error||Error('저장 실패'));tx.onabort=()=>reject(tx.error||Error('저장 중단'));});}
  };
}
