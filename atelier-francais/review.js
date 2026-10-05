import {AppError,makeEvent,normalizeAnswer,validateEvent} from './core.js';

export function reviewMonths(state) {
  return [...new Set(state.lessons.map(l=>l.date.slice(0,7)))].sort().reverse();
}

export function forgottenWords(state,month) {
  const lessons=new Map(state.lessons.filter(l=>l.date.slice(0,7)===month).map(l=>[l.id,l]));
  const words=new Map();
  for(const e of [...state.events].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.id.localeCompare(b.id))) {
    if(e.type!=='recall'||!lessons.has(e.lessonId))continue;
    const key=normalizeAnswer(e.payload.fr);
    words.set(key,{key,lessonId:e.lessonId,kind:e.payload.kind,prompt:e.payload.kind==='blank'?e.payload.prompt:e.payload.ko,ko:e.payload.ko,answer:e.payload.fr,remembered:e.payload.remembered,date:lessons.get(e.lessonId).date,title:lessons.get(e.lessonId).title});
  }
  return [...words.values()].filter(q=>!q.remembered);
}

export function newReviewSession(qs) {
  return {index:0,correct:0,answered:false,qs:structuredClone(qs),done:false,recorded:false,value:''};
}

export function recordAnswer(state,session,value) {
  if(!session||session.answered||session.done)return null;
  const q=session.qs[session.index];
  if(!q)throw new AppError('복습 문항을 다시 불러와 주세요.');
  const remembered=normalizeAnswer(value)===normalizeAnswer(q.answer);
  const event=makeEvent(state,q.lessonId,'recall',{fr:q.answer,ko:q.ko||q.prompt,prompt:q.prompt,kind:q.kind,remembered});
  // Preserve the order of consecutive answers even within the same millisecond.
  const previous=state.events.filter(e=>e.type==='recall'&&normalizeAnswer(e.payload.fr)===normalizeAnswer(q.answer)).reduce((max,e)=>Math.max(max,Date.parse(e.at)),0);
  event.at=new Date(Math.max(Date.now(),previous+1)).toISOString();
  validateEvent(event);
  state.events.push(event);
  session.value=value;session.answered=true;session.lastCorrect=remembered;
  if(remembered)session.correct++;
  return event;
}

export function nextQuestion(session) {
  if(!session?.answered||session.done)return false;
  if(session.index===session.qs.length-1)session.done=true;
  else {session.index++;session.answered=false;session.value='';}
  return true;
}
