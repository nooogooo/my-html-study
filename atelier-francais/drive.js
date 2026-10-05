import {ACCOUNT,APP,SCOPE,AppError,canonical,sha256,parseImport,mergeLessons,mergeEvents} from './core.js';
const BASE='https://www.googleapis.com/drive/v3';
export class DriveAdapter {
  constructor({fetcher=(...args)=>globalThis.fetch(...args),now=()=>Date.now()}={}){this.fetcher=fetcher;this.now=now;this.token=null;this.expires=0;}
  setToken(token,seconds){this.token=token;this.expires=this.now()+Number(seconds)*1000;}
  disconnect(){this.token=null;this.expires=0;}
  get connected(){return !!this.token&&this.now()<this.expires-30000;}
  async request(url,options={}) {
    if(!this.connected){this.disconnect();throw new AppError('Drive에 다시 연결해 주세요. 로컬 기록은 보존됩니다.','auth');}
    let r;
    try{r=await this.fetcher(url,{...options,headers:{...options.headers,Authorization:'Bearer '+this.token}});}catch{throw new AppError('네트워크 연결을 확인해 주세요. 저장 대기 기록은 보존됩니다.','network');}
    if(!r.ok){if(r.status===401){this.disconnect();throw new AppError('Drive 연결이 만료되었습니다. 다시 연결해 주세요.','auth');}if(r.status===403||r.status===404)throw new AppError('Drive 파일 접근 권한을 확인해 주세요. 앱이 만든 파일만 자동으로 읽을 수 있습니다.','access');if(r.status===409||r.status===412)throw new AppError('Drive 저장 충돌이 발생했습니다. 기록을 보존하고 중단했습니다.','conflict');throw new AppError('Drive 저장에 실패했습니다 ('+r.status+'). 다시 시도해 주세요.','drive');}return r;
  }
  async identity(){if(!ACCOUNT)throw new AppError('비공개 설정에 보관 계정을 먼저 저장해 주세요.','account');const x=await (await this.request(BASE+'/about?fields=user(emailAddress)')).json();if(x.user?.emailAddress?.toLowerCase()!==ACCOUNT){this.disconnect();throw new AppError(ACCOUNT+' 계정으로 다시 연결해 주세요.','account');}return x.user.emailAddress;}
  async files(){const files=[];let next='';do{const q="trashed=false and appProperties has { key='app' and value='"+APP+"' }";const p=new URLSearchParams({q,spaces:'drive',fields:'nextPageToken,files(id,name,appProperties,mimeType,size,parents)',pageSize:'100'});if(next)p.set('pageToken',next);const x=await (await this.request(BASE+'/files?'+p)).json();files.push(...(x.files||[]));next=x.nextPageToken||'';if(files.length>10000)throw new AppError('Drive 기록이 너무 많습니다. 분할 보관이 필요합니다.');}while(next);return files.sort((a,b)=>a.id.localeCompare(b.id));}
  async json(id){const r=await this.request(BASE+'/files/'+encodeURIComponent(id)+'?alt=media');const text=await r.text();if(text.length>5*1024*1024)throw new AppError('Drive JSON이 5MB를 초과했습니다.');try{return JSON.parse(text);}catch{throw new AppError('Drive JSON 파일이 손상되었습니다.','conflict');}}
  async blob(file){if(Number(file.size)>8*1024*1024||!['image/png','image/jpeg','image/webp'].includes(file.mimeType))throw new AppError('Drive 이미지 형식·크기를 확인해 주세요.');const r=await this.request(BASE+'/files/'+encodeURIComponent(file.id)+'?alt=media');const blob=await r.blob();if(blob.size>8*1024*1024)throw new AppError('Drive 이미지가 8MB를 초과했습니다.');const hash=await sha256(await blob.arrayBuffer());if(hash!==file.appProperties?.sha256)throw new AppError('Drive 이미지 검증에 실패했습니다. 원본을 보존했습니다.','conflict');return blob;}
  async upload(name,role,key,blob,extra={},parentId='') {
    const hash=await sha256(await blob.arrayBuffer());const metadata={name,mimeType:blob.type,appProperties:{app:APP,role,key,sha256:hash,...extra},...(parentId?{parents:[parentId]}:{})};
    const boundary='atelier_'+crypto.randomUUID().replace(/-/g,'');
    const body=new Blob(['--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n',JSON.stringify(metadata),'\r\n--'+boundary+'\r\nContent-Type: '+blob.type+'\r\n\r\n',blob,'\r\n--'+boundary+'--\r\n'],{type:'multipart/related; boundary='+boundary});
    const r=await this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,appProperties,mimeType,size',{method:'POST',headers:{'Content-Type':body.type},body});return r.json();
  }
  async verifyJSON(file,expected){const actual=await this.json(file.id);if(canonical(actual)!==canonical(expected))throw new AppError('Drive 저장 후 확인에 실패했습니다. 로컬 기록은 보존됩니다.','conflict');return actual;}
  folder(files,key,id='',parentId='') {
    const matches=files.filter(f=>f.mimeType==='application/vnd.google-apps.folder'&&f.appProperties?.role==='folder'&&f.appProperties.key===key&&(!parentId||f.parents?.includes(parentId)));
    if(id){const bound=matches.find(f=>f.id===id);if(!bound)throw new AppError('기존 보관 폴더에 접근할 수 없습니다. 연결 정보를 확인해 주세요.','access');return bound;}
    if(matches.length>1)throw new AppError('앱 보관 폴더가 여러 개입니다. 기존 폴더 ID를 지정해 주세요.','conflict');return matches[0];
  }
  async createFolder(name,key,parentId='') {
    const metadata={name,mimeType:'application/vnd.google-apps.folder',appProperties:{app:APP,role:'folder',key},...(parentId?{parents:[parentId]}:{})};
    return (await this.request(BASE+'/files?fields=id,name,mimeType,appProperties,parents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(metadata)})).json();
  }
  async assertPrivateFolder(id) {
    const metadata=await (await this.request(BASE+'/files/'+encodeURIComponent(id)+'?fields=mimeType,permissions(type)')).json();
    if(metadata.mimeType!=='application/vnd.google-apps.folder'||!Array.isArray(metadata.permissions))throw new AppError('보관 폴더의 공유 상태를 확인할 수 없습니다. 기록은 보존됩니다.','access');
    if(metadata.permissions.some(p=>['anyone','domain'].includes(p.type)))throw new AppError('보관 폴더가 공개되어 있습니다. 필사 기록을 저장하기 전에 개인 폴더로 연결해 주세요.','access');
  }
  async moveTo(file,parentId) {
    let parents=file.parents;if(!parents)parents=(await (await this.request(BASE+'/files/'+encodeURIComponent(file.id)+'?fields=parents')).json()).parents||[];
    if(parents.length===1&&parents[0]===parentId)return;
    const params=new URLSearchParams({addParents:parentId,fields:'id,parents'});if(parents.length)params.set('removeParents',parents.filter(id=>id!==parentId).join(','));
    const result=await (await this.request(BASE+'/files/'+encodeURIComponent(file.id)+'?'+params,{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{}'})).json();file.parents=result.parents||[parentId];
  }
  async preparePrivateFolders(state,persist,notify=()=>{}) {
    await this.identity();const files=await this.files();
    let root=this.folder(files,'private-root',state.rootFolderId);if(!root){notify('개인 보관 폴더 만들기');root=await this.createFolder('Atelier français','private-root');files.push(root);}state.rootFolderId=root.id;await this.assertPrivateFolder(root.id);await persist(state);
    for(const [key,name,field]of [['sources','수업 자료','sourceFolderId'],['records','필사 기록','recordsFolderId']]){let folder=this.folder(files,key,state[field],root.id);if(!folder){folder=await this.createFolder(name,key,root.id);files.push(folder);}state[field]=folder.id;await this.assertPrivateFolder(folder.id);await persist(state);}
    if(state.catalogId){const file=files.find(f=>f.id===state.catalogId&&f.appProperties?.role==='catalog');if(!file)throw new AppError('기존 catalog 연결을 확인해 주세요.','access');await this.moveTo(file,root.id);}
    return state;
  }
  async dateFolder(state,files,date) {
    if(!state.rootFolderId)return '';
    this.folder(files,'private-root',state.rootFolderId);this.folder(files,'records',state.recordsFolderId,state.rootFolderId);
    state.dateFolderIds ||= {};let folder=this.folder(files,'date:'+date,state.dateFolderIds[date],state.recordsFolderId);
    if(!folder){folder=await this.createFolder(date,'date:'+date,state.recordsFolderId);files.push(folder);}await this.assertPrivateFolder(folder.id);state.dateFolderIds[date]=folder.id;return folder.id;
  }
  async sync(state,persist,notify=()=>{}) {
    // Never mutate a shared remote file after bootstrap. Records and assets are immutable.
    await this.identity();let files=await this.files();const knownRoot=this.folder(files,'private-root',state.rootFolderId);if(knownRoot){await this.assertPrivateFolder(knownRoot.id);const records=this.folder(files,'records',state.recordsFolderId,knownRoot.id);if(records)await this.assertPrivateFolder(records.id);const sources=this.folder(files,'sources',state.sourceFolderId,knownRoot.id);if(sources)await this.assertPrivateFolder(sources.id);}let catalogs=files.filter(f=>f.appProperties?.role==='catalog');
    if(state.catalogId){const bound=catalogs.find(f=>f.id===state.catalogId);if(!bound)throw new AppError('연결된 catalog에 접근할 수 없습니다. 계정·클라이언트ID·파일 권한을 확인해 주세요.','access');catalogs=[bound];}
    if(catalogs.length>1)throw new AppError('catalog가 여러 개입니다. 설정에서 기존 catalog ID를 지정해 주세요.','conflict');
    if(!catalogs.length){notify('수업 연결 파일 만들기');const content={schemaVersion:1,lessons:[]};const f=await this.upload('Atelier-francais-catalog.json','catalog','catalog',new Blob([JSON.stringify(content)],{type:'application/json'}),{},state.rootFolderId||'');await this.verifyJSON(f,content);catalogs=[f];files.push(f);}
    const catalog=catalogs[0];const catalogContent=await this.json(catalog.id);
    if(catalogContent.schemaVersion!==1||!Array.isArray(catalogContent.lessons))throw new AppError('catalog 형식을 확인해 주세요.','conflict');
    const incoming=parseImport(JSON.stringify(catalogContent));let remoteEvents=[];
    for(const f of files.filter(f=>['lesson','event'].includes(f.appProperties?.role))){notify('수업·기록 확인 중');const x=await this.json(f.id);if(await sha256(JSON.stringify(x))!==f.appProperties.sha256)throw new AppError('Drive JSON 검증에 실패했습니다. 로컬 기록을 보존했습니다.','conflict');if(f.appProperties.role==='lesson'){const parsed=parseImport(JSON.stringify(x));incoming.push(...parsed);f.relatedLessonId=parsed[0]?.id;}else{remoteEvents.push({...x,synced:true});f.relatedLessonId=x.lessonId;}}
    // Higher revisions are authoritative, same-revision divergence is stopped before uploads.
    incoming.sort((a,b)=>a.revision-b.revision);
    const merged=mergeLessons(state.lessons,incoming,{updates:true,remote:true});
    const events=mergeEvents(state.events,remoteEvents);
    const work=structuredClone(state);work.lessons=merged.lessons;work.events=events;work.catalogId=catalog.id;
    const rootFolder=this.folder(files,'private-root',state.rootFolderId);if(rootFolder){work.rootFolderId=rootFolder.id;work.recordsFolderId=this.folder(files,'records',state.recordsFolderId,rootFolder.id)?.id||'';work.sourceFolderId=this.folder(files,'sources',state.sourceFolderId,rootFolder.id)?.id||'';if(!work.recordsFolderId||!work.sourceFolderId)throw new AppError('개인 보관 폴더 준비를 완료해 주세요.','access');}
    work.dateFolderIds ||= {};
    work.syncedLessons={};
    const remoteEventIds=new Set(remoteEvents.map(e=>e.id));
    for(const e of work.events)e.synced=remoteEventIds.has(e.id);
    for(const l of work.lessons){if(incoming.some(r=>canonical(r)===canonical(l)))work.syncedLessons[l.id]=canonical(l);}
    await persist(work);
    const remoteAssetFiles=files.filter(f=>f.appProperties?.role==='asset');
    for(const a of work.assets)if(a.driveId&&!remoteAssetFiles.some(f=>f.id===a.driveId&&f.appProperties.key===a.id))delete a.driveId;
    await persist(work);
    for(const e of work.events.filter(e=>e.type==='asset')){
      if(work.assets.some(a=>a.id===e.payload.assetId))continue;
      const f=remoteAssetFiles.find(f=>f.appProperties.key===e.payload.assetId);if(!f)throw new AppError('필사 이미지가 Drive에서 누락되었습니다. 학습 기록은 보존됩니다.','conflict');
      notify('필사 이미지 내려받기');const blob=await this.blob(f);work.assets.push({id:e.payload.assetId,lessonId:e.lessonId,kind:e.payload.kind,name:e.payload.name||'필사',at:e.at,blob,driveId:f.id});await persist(work);
    }
    if(work.rootFolderId){await this.moveTo(catalog,work.rootFolderId);for(const file of files.filter(f=>['lesson','event','asset'].includes(f.appProperties?.role))){const asset=work.assets.find(a=>a.driveId===file.id),id=file.relatedLessonId||asset?.lessonId,lesson=work.lessons.find(l=>l.id===id);if(!lesson)continue;const parent=await this.dateFolder(work,files,lesson.date);await this.moveTo(file,parent);}await persist(work);}
    for(const l of work.lessons){if(work.syncedLessons[l.id]===canonical(l))continue;notify('수업 저장 중');const value=JSON.stringify(l),key=await sha256(canonical(l));let f=files.find(f=>f.appProperties?.role==='lesson'&&f.appProperties.key===key);if(!f){f=await this.upload('lesson-'+l.source.messageId+'-r'+l.revision+'.json','lesson',key,new Blob([value],{type:'application/json'}),{},await this.dateFolder(work,files,l.date));files.push(f);}await this.verifyJSON(f,l);work.syncedLessons[l.id]=canonical(l);await persist(work);}
    for(const a of work.assets.filter(a=>!a.driveId)){notify('필사·사진 저장 중');let f=files.find(f=>f.appProperties?.role==='asset'&&f.appProperties.key===a.id);if(!f){f=await this.upload(a.id+(a.blob.type==='image/jpeg'?'.jpg':'.png'),'asset',a.id,a.blob,{},await this.dateFolder(work,files,work.lessons.find(l=>l.id===a.lessonId).date));files.push(f);}const remote=await this.blob(f);if(await sha256(await remote.arrayBuffer())!==await sha256(await a.blob.arrayBuffer()))throw new AppError('이미지 ID 충돌입니다. 로컬 원본을 보존했습니다.','conflict');a.driveId=f.id;await persist(work);}
    for(const e of work.events.filter(e=>!e.synced)){notify('학습 기록 저장 중');const {synced,...value}=e;let f=files.find(f=>f.appProperties?.role==='event'&&f.appProperties.key===e.id);if(!f){f=await this.upload('event-'+e.id+'.json','event',e.id,new Blob([JSON.stringify(value)],{type:'application/json'}),{},await this.dateFolder(work,files,work.lessons.find(l=>l.id===e.lessonId).date));files.push(f);}await this.verifyJSON(f,value);e.synced=true;await persist(work);}
    work.lastSync=new Date().toISOString();await persist(work);return work;
  }
}
export function authorize(adapter,clientId,gis=globalThis.google?.accounts?.oauth2) {
  if(!ACCOUNT)return Promise.reject(new AppError('비공개 설정에 보관 계정을 먼저 저장해 주세요.','account'));
  if(!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId||''))return Promise.reject(new AppError('설정에 Google OAuth 웹 클라이언트 ID를 입력해 주세요.','config'));
  if(!gis)return Promise.reject(new AppError('Google 연결 도구를 불러오는 중입니다. 네트워크를 확인하고 다시 눌러 주세요.','auth'));
  return new Promise((resolve,reject)=>{
    let settled=false;const done=(err,response)=>{if(settled)return;settled=true;clearTimeout(timer);if(err){adapter.disconnect();reject(err);}else{adapter.setToken(response.access_token,response.expires_in);resolve();}};
    const timer=setTimeout(()=>done(new AppError('연결 창을 닫았거나 응답이 지연되었습니다. 다시 연결해 주세요.','cancel')),120000);
    try{const client=gis.initTokenClient({client_id:clientId,scope:SCOPE,include_granted_scopes:false,login_hint:ACCOUNT,callback:r=>{if(r.error||!r.access_token||!gis.hasGrantedAllScopes(r,SCOPE)){done(new AppError('Drive 권한 연결이 완료되지 않았습니다. 기록은 보존됩니다.','cancel'));return;}done(null,r);},error_callback:()=>done(new AppError('Google 연결이 취소되었습니다. 기록은 보존됩니다.','cancel'))});client.requestAccessToken({prompt:'select_account'});}catch{done(new AppError('Google 연결 창을 열 수 없습니다. 다시 시도해 주세요.','auth'));}
  });
}
