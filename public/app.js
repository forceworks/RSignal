import { score } from './scoring.js';
import { authorIdentity, readAuthorRules, authorMode, changeAuthorRule } from './author-rules.js';
import { mergeScanPosts, normalizePostIdentity, postIdentity, restoreFeed } from './feed-state.js';
import { createScanRunner, inQuietHours as quietNow, screenInBatches, fetchFollowerBatches } from './scan-policy.js';

const apiCapability=window.signalDesktop?await window.signalDesktop.getApiCapability():'';
function apiFetch(path,options={}){const headers=new Headers(options.headers||{});if(apiCapability)headers.set('X-RSignals-Capability',apiCapability);return fetch(path,{...options,headers});}

const defaults = [
  'workflow automation OR business software',
  'enterprise AI workflow',
  'developer tools OR SaaS'
];
const emptyQueries=[];
const storedHidden=JSON.parse(localStorage.getItem('signal:hidden')||'[]');
const state={
  authorRules:readAuthorRules(localStorage),
  posts:restoreFeed(localStorage,{maxAgeHours:Number(localStorage.getItem('signal:maxAgeHours')||3),hidden:storedHidden}),saved:JSON.parse(localStorage.getItem('signal:saved')||'[]'),hidden:[...new Set((Array.isArray(storedHidden)?storedHidden:[]).map(normalizePostIdentity).filter(Boolean))],queriesX:JSON.parse(localStorage.getItem('signal:queries:x')||'null')||[...defaults],queriesLinkedIn:JSON.parse(localStorage.getItem('signal:queries:linkedin')||'null')||[...defaults],queriesReddit:JSON.parse(localStorage.getItem('signal:queries:reddit')||'null')||[...emptyQueries],queriesYoutube:JSON.parse(localStorage.getItem('signal:queries:youtube')||'null')||[...emptyQueries],queriesTiktok:JSON.parse(localStorage.getItem('signal:queries:tiktok')||'null')||[...emptyQueries],queriesSubstack:JSON.parse(localStorage.getItem('signal:queries:substack')||'null')||[...emptyQueries],
  limit:Number(localStorage.getItem('signal:limit')||12),minFollowers:Number(localStorage.getItem('signal:minFollowers')||0),maxAgeHours:Number(localStorage.getItem('signal:maxAgeHours')||3),scanInterval:Number(localStorage.getItem('signal:scanInterval')||15),notifyScore:Number(localStorage.getItem('signal:notifyScore')||70),notificationsEnabled:localStorage.getItem('signal:notificationsEnabled')!=='false',quietHoursEnabled:localStorage.getItem('signal:quietHoursEnabled')==='true',quietStart:localStorage.getItem('signal:quietStart')||'22:00',quietEnd:localStorage.getItem('signal:quietEnd')||'07:00',quietDays:JSON.parse(localStorage.getItem('signal:quietDays')||'null')||[0,6],
  platforms:JSON.parse(localStorage.getItem('signal:platforms')||'null')||['x','linkedin'],filter:'all',aiProfile:localStorage.getItem('signal:aiProfile')||'',aiInstructions:localStorage.getItem('signal:aiInstructions')||'',aiStatus:null,aiResults:new Map(),articleResults:new Map()
};
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const feed=$('#feed'),savedFeed=$('#savedFeed'),empty=$('#empty'),keyStatus=$('#keyStatus'),autoScanMeta=$('#autoScanMeta'),queriesX=$('#queriesX'),queriesLinkedIn=$('#queriesLinkedIn'),queriesReddit=$('#queriesReddit'),queriesYoutube=$('#queriesYoutube'),queriesTiktok=$('#queriesTiktok'),queriesSubstack=$('#queriesSubstack'),limit=$('#limit'),minFollowers=$('#minFollowers'),maxAgeHours=$('#maxAgeHours'),scanInterval=$('#scanInterval'),notifyScore=$('#notifyScore'),notificationsEnabled=$('#notificationsEnabled'),quietHoursEnabled=$('#quietHoursEnabled'),quietStart=$('#quietStart'),quietEnd=$('#quietEnd'),quietDays=$$('.quiet-day'),startWithWindows=$('#startWithWindows'),platformX=$('#platformX'),platformLinkedIn=$('#platformLinkedIn'),platformReddit=$('#platformReddit'),platformYoutube=$('#platformYoutube'),platformTiktok=$('#platformTiktok'),platformSubstack=$('#platformSubstack'),aiStatus=$('#aiStatus'),aiStatusDetail=$('#aiStatusDetail'),connectChatGPT=$('#connectChatGPT'),disconnectAi=$('#disconnectAi'),openAiApiKey=$('#openAiApiKey'),saveOpenAiKey=$('#saveOpenAiKey'),aiInstructions=$('#aiInstructions'),aiProfile=$('#aiProfile'); let scanTimer,scheduleTicker,nextScanAt=0,lastAutoScanAt=0,followerEnrichmentId=0,aiPollTimer,aiPollBusy=false;
const updateBanner=$('#updateBanner'),updateVersion=$('#updateVersion'),downloadUpdate=$('#downloadUpdate'),updateCheckIntervalMs=24*60*60*1000;
queriesX.value=state.queriesX.join('\n'); queriesLinkedIn.value=state.queriesLinkedIn.join('\n'); queriesReddit.value=state.queriesReddit.join('\n'); queriesYoutube.value=state.queriesYoutube.join('\n'); queriesTiktok.value=state.queriesTiktok.join('\n'); queriesSubstack.value=state.queriesSubstack.join('\n'); limit.value=state.limit; minFollowers.value=state.minFollowers; maxAgeHours.value=state.maxAgeHours; scanInterval.value=state.scanInterval; notifyScore.value=state.notifyScore; notificationsEnabled.checked=state.notificationsEnabled; quietHoursEnabled.checked=state.quietHoursEnabled; quietStart.value=state.quietStart; quietEnd.value=state.quietEnd; quietDays.forEach(day=>day.checked=state.quietDays.includes(Number(day.value))); platformX.checked=state.platforms.includes('x'); platformLinkedIn.checked=state.platforms.includes('linkedin'); platformReddit.checked=state.platforms.includes('reddit'); platformYoutube.checked=state.platforms.includes('youtube'); platformTiktok.checked=state.platforms.includes('tiktok'); platformSubstack.checked=state.platforms.includes('substack'); aiInstructions.value=state.aiInstructions; aiProfile.value=state.aiProfile;
if(window.signalDesktop) window.signalDesktop.getStartup().then(v=>startWithWindows.checked=v); checkStatus(); checkForUpdate();
function minutesAgo(date){const time=new Date(date).getTime();if(!Number.isFinite(time))return'time unavailable';const m=Math.max(0,Math.floor((Date.now()-time)/60000));if(m<1)return'now';return m<60?`${m}m`:m<1440?`${Math.floor(m/60)}h`:`${Math.floor(m/1440)}d`;}
function exactTime(date){const d=new Date(date);return Number.isNaN(d.getTime())?'':d.toLocaleString();}
const platformNames={x:'X',linkedin:'LinkedIn',reddit:'Reddit',youtube:'YouTube',tiktok:'TikTok',substack:'Substack'};
function platformLabel(post){return platformNames[post.platform]||post.platform||'Source';}
function authorSecondary(post){if(post.platform==='linkedin') return post.author.username&&post.author.username!=='unknown'?escapeHtml(post.author.username):'LinkedIn';if(post.platform==='reddit')return post.author.username&&post.author.username!=='unknown'?`u/${escapeHtml(post.author.username)}`:'Reddit';if(post.platform==='tiktok')return post.author.username&&post.author.username!=='unknown'?`@${escapeHtml(post.author.username)}`:'TikTok';if(post.platform==='substack')return post.author.username&&post.author.username!=='unknown'?escapeHtml(post.author.username):'Substack';return `@${escapeHtml(post.author.username)}`;}
function followerMarkup(post){const value=post.author?.followers;if(value===null||value===undefined||!Number.isFinite(Number(value)))return'';const count=Number(value);return`<span class="followers" title="${count.toLocaleString()} followers">· ${format(count)} followers</span>`;}
function queryTerms(query){const source=String(query||''),quoted=[...source.matchAll(/"([^"]+)"/g)].map(match=>match[1].trim()).filter(Boolean),bare=source.replace(/"[^"]*"/g,' ').replace(/(^|\s)-?(?:from|to|lang|since|until|filter|is):\S+/gi,' ').replace(/[()]/g,' ').split(/\s+/).map(term=>term.trim()).filter(term=>term&&!/^(?:AND|OR|NOT)$/i.test(term)&&term.length>1),unique=new Map();for(const term of [...quoted,...bare])if(!unique.has(term.toLowerCase()))unique.set(term.toLowerCase(),term);return [...unique.values()].sort((a,b)=>b.length-a.length);}
function highlightQueryTerms(text,query){const value=String(text||''),terms=queryTerms(query);if(!terms.length)return escapeHtml(value);const escaped=terms.map(term=>term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),pattern=new RegExp(`(?<![\\p{L}\\p{N}_])(?:${escaped.join('|')})(?![\\p{L}\\p{N}_])`,'giu');let html='',last=0;for(const match of value.matchAll(pattern)){html+=escapeHtml(value.slice(last,match.index))+`<mark class="search-hit">${escapeHtml(match[0])}</mark>`;last=match.index+match[0].length;}return html+escapeHtml(value.slice(last));}
function updatePostOverflow(card){const text=card.querySelector('.post-text'),more=card.querySelector('.post-more');if(!text||!more||text.classList.contains('expanded'))return;more.classList.toggle('hidden',text.clientHeight===0||text.scrollHeight<=text.clientHeight+1);}
function refreshPostOverflow(){document.querySelectorAll('.card').forEach(updatePostOverflow);}
function safeExternalUrl(value){try{const parsed=new URL(String(value||''));return parsed.protocol==='https:'?parsed.href:'';}catch{return'';}}
function attachmentMarkup(post){
  const attachment=post.attachment;
  if(!attachment||attachment.type==='text')return'';
  const url=safeExternalUrl(attachment.url),image=safeExternalUrl(attachment.image),type=String(attachment.type||'attachment').toLowerCase();
  const hasDetails=image||attachment.title||attachment.subtitle||attachment.description;
  if(!hasDetails)return'';
  const source=post.platform==='x'?'X':'LinkedIn',labels={article:`${source} article`,video:`${source} video`,job:'LinkedIn job'};
  const label=labels[type]||`${source} attachment`,title=attachment.title||label,summary=attachment.subtitle||attachment.description,canLoad=post.platform==='linkedin'&&type==='article'&&url&&!post.article;
  return `<section class="attachment-card ${escapeHtml(type)}">${image?`<img src="${escapeHtml(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:''}<div class="attachment-copy"><span>${escapeHtml(label)}</span><strong>${escapeHtml(title)}</strong>${summary?`<p>${escapeHtml(summary)}</p>`:''}${attachment.subtitle&&attachment.description?`<small>${escapeHtml(attachment.description)}</small>`:''}<div class="attachment-actions">${canLoad?'<button class="secondary load-article" type="button">Load article</button>':''}${url?`<button class="secondary open-attachment" type="button">Open ${escapeHtml(type==='article'?'article':type==='video'?'video':'attachment')}</button>`:''}</div></div></section>`;
}
function removeBrokenAttachmentImages(card){card.querySelectorAll('.attachment-card>img').forEach(image=>{const remove=()=>image.remove();image.addEventListener('error',remove,{once:true});if(image.complete&&image.naturalWidth===0)remove();});}
function renderCard(post,showHide=true){
  const s=score(post),isSaved=state.saved.some(x=>x.url===post.url),card=document.createElement('article');
  card.className='card';
  card.dataset.postKey=postIdentity(post);
  card.innerHTML=`<div class="score"><strong>${s}</strong><span>fit score</span></div><div class="content"><div class="author"><span class="platform ${post.platform}">${platformLabel(post)}</span><strong>${escapeHtml(post.author.name)}</strong>${post.author.verified?'<span class="verified">●</span>':''}<span class="handle">${authorSecondary(post)}</span>${followerMarkup(post)}${authorBadge(post)}<span class="time" title="${escapeHtml(exactTime(post.createdAt))}">· ${minutesAgo(post.createdAt)}</span></div><div class="post-text clamped">${highlightQueryTerms(post.text,post.query)}</div><button class="post-more hidden" type="button" aria-expanded="false">More</button>${attachmentMarkup(post)}<div class="metrics"><span>↩ ${post.replies}</span><span>♥ ${post.likes}</span><span>↻ ${post.reposts}</span>${post.views?`<span>◉ ${format(post.views)}</span>`:''}</div><span class="query-chip">${escapeHtml(post.query)}</span></div><div class="actions"><button class="icon-btn save ${isSaved?'saved':''}" title="Save">${isSaved?'★':'☆'}</button><button class="icon-btn ai-assist" title="Assess relevance and draft replies">AI Assist</button><button class="icon-btn inspect">View</button>${showHide?'<button class="icon-btn hide" title="Hide from opportunities">Hide</button>':''}${authorControls(post)}</div>`;
  removeBrokenAttachmentImages(card);
  const text=card.querySelector('.post-text'),more=card.querySelector('.post-more');
  more.onclick=()=>{const expanded=text.classList.toggle('expanded');more.textContent=expanded?'Less':'More';more.setAttribute('aria-expanded',String(expanded));if(!expanded)requestAnimationFrame(()=>updatePostOverflow(card));};
  if(authorIdentity(post)){
    card.querySelector('.prefer-author').onclick=()=>setAuthorRule(post,authorMode(post,state.authorRules)==='preferred'?'':'preferred');
    card.querySelector('.block-author').onclick=()=>setAuthorRule(post,authorMode(post,state.authorRules)==='blocked'?'':'blocked');
  }
  card.querySelector('.save').onclick=()=>toggleSave(post);
  card.querySelector('.ai-assist').onclick=()=>runAiAssist(post,card);
  card.querySelector('.inspect').onclick=()=>openPost(post);
  card.querySelector('.open-attachment')?.addEventListener('click',()=>openExternalUrl(post.attachment.url));
  card.querySelector('.load-article')?.addEventListener('click',()=>loadLinkedInArticle(post,card));
  if(showHide)card.querySelector('.hide').onclick=()=>hidePost(post);
  const prior=state.aiResults.get(postIdentity(post));if(prior)renderAiResult(card,prior);
  const article=post.article?{article:post.article,embedded:true}:state.articleResults.get(postIdentity(post));if(article)renderArticleResult(post,card,article);
  requestAnimationFrame(()=>updatePostOverflow(card));return card;
}

function isAuthorBlocked(post){return authorMode(post,state.authorRules)==='blocked';}
function authorBadge(post){const mode=authorMode(post,state.authorRules);return mode?`<span class="author-preference ${mode}">${mode==='preferred'?'Preferred author':'Blocked author'}</span>`:'';}
function authorControls(post){
  if(!authorIdentity(post))return '';
  const mode=authorMode(post,state.authorRules);
  return `<details class="author-menu"><summary>Author</summary><button class="icon-btn prefer-author" type="button">${mode==='preferred'?'Remove priority':'Prioritize author'}</button><button class="icon-btn block-author" type="button">${mode==='blocked'?'Unblock author':'Block author'}</button></details>`;
}
function saveAuthorRule(author,mode){
  const next=changeAuthorRule(state.authorRules,author,mode);
  try{localStorage.setItem('signal:authorRules',JSON.stringify(next));}
  catch{$('#scanMeta').textContent=$('#authorRuleStatus').textContent='Could not save author preferences. Check available disk space.';return false;}
  state.authorRules=next;
  $('#authorRuleStatus').textContent=mode==='blocked'?'Author blocked. Saved posts are unchanged.':mode==='preferred'?'Author prioritized in Best matches.':'Author preference removed.';
  render();
  return true;
}
function setAuthorRule(post,mode){
  const key=authorIdentity(post);
  if(!key)return false;
  return saveAuthorRule({key,platform:post.platform,label:post.author.name||post.author.username||key},mode);
}
function renderAuthorRules(){
  for(const [mode,selector] of [['blocked','#blockedAuthors'],['preferred','#preferredAuthors']]){
    const rules=state.authorRules.filter(rule=>rule.mode===mode);
    const rows=rules.map(rule=>{
      const row=document.createElement('div');row.className='author-rule-row';
      row.innerHTML=`<span>${escapeHtml(rule.label)}<small>${escapeHtml(platformNames[rule.platform])} · ${escapeHtml(rule.key.slice(rule.platform.length+1))}</small></span><button class="secondary" type="button">${mode==='blocked'?'Unblock':'Remove'}</button>`;
      row.querySelector('button').onclick=()=>saveAuthorRule(rule,'');
      return row;
    });
    $(selector).replaceChildren(...rows);
    if(!rows.length)$(selector).innerHTML=`<p class="author-rule-empty">No ${mode} authors.</p>`;
  }
}

function passesFollowerFilter(post){if(state.minFollowers<=0||!['x','linkedin'].includes(post.platform))return true;const followers=Number(post.author?.followers);return Number.isFinite(followers)&&followers>=state.minFollowers;}
function visiblePosts(){return state.posts.filter(post=>!state.hidden.includes(postIdentity(post))&&!isAuthorBlocked(post)&&passesFollowerFilter(post));}
function pruneExpiredPosts(){const fresh=mergeScanPosts(state.posts,[],{maxAgeHours:state.maxAgeHours,hidden:state.hidden});const changed=fresh.length!==state.posts.length;state.posts=fresh;try{localStorage.setItem('signal:posts',JSON.stringify(fresh));}catch{ $('#scanMeta').textContent='Could not save opportunities locally. Check available disk space.'; }return changed;}
function render(){pruneExpiredPosts();let posts=visiblePosts();if(state.filter==='fresh')posts.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));else if(state.filter==='momentum')posts.sort((a,b)=>(b.likes+b.replies*3+b.reposts*2)-(a.likes+a.replies*3+a.reposts*2));else posts.sort((a,b)=>Number(authorMode(b,state.authorRules)==='preferred')-Number(authorMode(a,state.authorRules)==='preferred')||score(b)-score(a));feed.replaceChildren(...posts.map(post=>renderCard(post)));empty.classList.toggle('hidden',posts.length>0);savedFeed.replaceChildren(...state.saved.map(post=>renderCard(post,false)));if(!state.saved.length)savedFeed.innerHTML='<div class="empty"><h2>Nothing saved yet</h2><p>Use the star on an opportunity to keep it here.</p></div>';updateCounts();renderAuthorRules();}
function followerAuthorKey(platform,author={}){const username=String(author.username||'').replace(/^@/,'').toLowerCase();if(username&&username!=='unknown')return`${platform}:${username}`;const profile=String(author.profileUrl||'').toLowerCase().replace(/\/+$/,'');return profile?`${platform}:${profile}`:'';}
async function enrichFollowers(posts,enrichmentId){
  const authors=posts.filter(post=>!isAuthorBlocked(post)&&['x','linkedin'].includes(post.platform)&&post.author?.followers==null).map(post=>({platform:post.platform,username:post.author.username,profileUrl:post.author.profileUrl}));
  if(!authors.length)return;
  try{
    const data=await fetchFollowerBatches(authors,async batch=>{
      const response=await apiFetch('/api/followers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({authors:batch})});
      if(!response.ok)throw new Error('Follower lookup failed');
      return response.json();
    });
    if(enrichmentId!==followerEnrichmentId)return;
    const followersByAuthor=new Map((data.profiles||[]).map(profile=>[followerAuthorKey(profile.platform,profile),profile.followers]));
    let changed=false,savedChanged=false;
    for(const post of state.posts){const followers=followersByAuthor.get(followerAuthorKey(post.platform,post.author));if(followers!==undefined&&post.author.followers!==followers){post.author.followers=followers;changed=true;}}
    for(const post of state.saved){const followers=followersByAuthor.get(followerAuthorKey(post.platform,post.author));if(followers!==undefined&&post.author.followers!==followers){post.author.followers=followers;savedChanged=true;}}
    if(savedChanged)localStorage.setItem('signal:saved',JSON.stringify(state.saved));
    if(changed||savedChanged)render();
    if(Number(data.costUsd)>0)$('#scanMeta').textContent+=` · followers $${Number(data.costUsd).toFixed(4)}`;
    if(Number(data.failures)>0)$('#scanMeta').textContent+=` · ${Number(data.failures)} follower count${Number(data.failures)===1?'':'s'} unavailable`;
  }catch{}
}
function formatCountdown(milliseconds){const total=Math.ceil(Math.max(0,milliseconds)/1000);return`${Math.floor(total/60)}m ${String(total%60).padStart(2,'0')}s`;}
function inQuietHours(date=new Date()){return quietNow(state,date);}
function updateAutoScanStatus(){if(!autoScanMeta)return;const last=lastAutoScanAt?` · last ${new Date(lastAutoScanAt).toLocaleTimeString()}`:'';if(inQuietHours()){autoScanMeta.textContent=`Quiet hours active · automatic scans paused${last}`;return;}autoScanMeta.textContent=`Next automatic scan in ${formatCountdown(nextScanAt-Date.now())}${last}`;}
function scheduleAutomaticScan(){clearInterval(scanTimer);clearInterval(scheduleTicker);const intervalMs=Math.max(5,Number(state.scanInterval)||15)*60000;nextScanAt=Date.now()+intervalMs;updateAutoScanStatus();scheduleTicker=setInterval(updateAutoScanStatus,1000);scanTimer=setInterval(()=>{nextScanAt=Date.now()+intervalMs;updateAutoScanStatus();void scan(true);},intervalMs);}
async function notifyFresh(posts){if(!window.signalDesktop||!state.notificationsEnabled||inQuietHours())return;const strong=posts.filter(p=>!isAuthorBlocked(p)&&passesFollowerFilter(p)&&score(p)>=state.notifyScore);if(!strong.length)return;const top=strong.sort((a,b)=>score(b)-score(a))[0],title=strong.length===1?`RSignals found a fresh ${platformLabel(top)} post`:`RSignals found ${strong.length} fresh posts`,body=`${top.author.name} · ${platformLabel(top)} · score ${score(top)} — ${top.text.slice(0,125)}`;await window.signalDesktop.notify({title,body,postKey:strong.length===1?postIdentity(top):''});}
function applyAiStatus(status){state.aiStatus=status;const connected=Boolean(status?.connected),screening=Boolean(state.aiInstructions.trim());aiStatus.textContent=connected?status.authMode==='chatgpt'?`ChatGPT connected${status.planType?` · ${status.planType}`:''}`:'OpenAI API key connected':status?.available?'AI Assist not connected':'AI Assist unavailable';aiStatus.className=`key-status ${connected?'key-saved':'key-missing'}`;aiStatusDetail.textContent=connected?screening?'AI Assist is ready. Engagement instructions will screen each new scan batch.':'AI Assist is ready. Add engagement instructions to screen new scan batches.':status?.error||'Use your ChatGPT subscription or your own OpenAI API key.';connectChatGPT.classList.toggle('hidden',connected);disconnectAi.classList.toggle('hidden',!connected);}
async function checkAiStatus(){try{const response=await apiFetch('/api/ai/status'),status=await response.json();applyAiStatus(status);return status;}catch(error){const status={available:false,connected:false,error:error.message||'Could not reach AI Assist.'};applyAiStatus(status);return status;}}
function stopAiPolling(){clearInterval(aiPollTimer);aiPollTimer=null;}
function pollForAiConnection(){stopAiPolling();let attempts=0;aiPollTimer=setInterval(async()=>{if(aiPollBusy)return;aiPollBusy=true;try{const status=await checkAiStatus();attempts++;if(status.connected||attempts>=60){stopAiPolling();connectChatGPT.disabled=false;connectChatGPT.textContent='Connect ChatGPT';}}finally{aiPollBusy=false;}},2000);}
async function openExternalUrl(url){if(window.signalDesktop){try{const opened=await window.signalDesktop.openExternal(url);if(opened===false)$('#scanMeta').textContent='This link could not be opened. Only secure HTTPS links are supported.';return opened;}catch{$('#scanMeta').textContent='The link could not be opened in your browser.';return false;}}window.open(url,'_blank','noopener,noreferrer');}
function renderArticleResult(post,card,result){
  let panel=card.querySelector('.article-panel');if(!panel){panel=document.createElement('section');panel.className='article-panel';card.querySelector('.content').append(panel);}
  if(result.error){panel.className='article-panel article-error';panel.innerHTML=`<strong>Article unavailable</strong><p>${escapeHtml(result.error)}</p>`;return;}
  const article=result.article||{},followers=Number(article.author?.followers),authorMeta=[article.author?.name,article.author?.followers!=null&&Number.isFinite(followers)?`${format(followers)} followers`:null].filter(Boolean).join(' · ');
  panel.className='article-panel';
  const engagement=post.platform==='x'?`${article.likes||0} likes · ${article.replies||0} replies${article.quotes?` · ${article.quotes} quotes`:''}`:`${article.reactions||0} reactions · ${article.comments||0} comments`;
  panel.innerHTML=`<div class="article-panel-head"><div><span>Article content</span><strong>${escapeHtml(article.title||post.attachment?.title||`${platformLabel(post)} article`)}</strong>${authorMeta?`<small>${escapeHtml(authorMeta)}</small>`:''}</div><small>${result.cached?'Cached locally':result.embedded?'Included in scan':'Loaded via AnyAPI'}</small></div>${article.description?`<p class="article-description">${escapeHtml(article.description)}</p>`:''}<div class="article-body clamped">${highlightQueryTerms(article.body,post.query)}</div><button class="article-more hidden" type="button" aria-expanded="false">More</button><div class="article-footer"><span>${escapeHtml(engagement)}</span><button class="secondary read-full-article" type="button">Read full article</button></div>`;
  const body=panel.querySelector('.article-body'),more=panel.querySelector('.article-more');
  more.onclick=()=>{const expanded=body.classList.toggle('expanded');more.textContent=expanded?'Less':'More';more.setAttribute('aria-expanded',String(expanded));};
  panel.querySelector('.read-full-article').onclick=()=>openExternalUrl(article.url||post.attachment.url);
  requestAnimationFrame(()=>more.classList.toggle('hidden',body.clientHeight===0||body.scrollHeight<=body.clientHeight+1));
}
async function loadLinkedInArticle(post,card){
  const button=card.querySelector('.load-article'),original=button?.textContent||'Load article';if(button){button.disabled=true;button.textContent='Loading…';}
  try{const response=await apiFetch('/api/linkedin/article',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:post.attachment?.url})}),result=await response.json();if(!response.ok)throw new Error(result.error||'Article could not be loaded.');state.articleResults.set(postIdentity(post),result);renderArticleResult(post,card,result);if(button)button.textContent='Loaded';}
  catch(error){renderArticleResult(post,card,{error:error.message||'Article could not be loaded.'});if(button){button.disabled=false;button.textContent=original;}}
}
function renderAiResult(card,result){let panel=card.querySelector('.ai-panel');if(!panel){panel=document.createElement('section');panel.className='ai-panel';card.querySelector('.content').append(panel);}if(result.error){panel.className='ai-panel ai-error';panel.innerHTML=`<div class="ai-panel-head"><strong>AI Assist unavailable</strong></div><p>${escapeHtml(result.error)}</p>`;return;}panel.className='ai-panel';panel.innerHTML=`<div class="ai-panel-head"><div><span class="ai-badge ${result.relevance}">${escapeHtml(result.relevance)} relevance · ${result.relevanceScore}</span><strong>${escapeHtml(result.summary)}</strong></div><small>${escapeHtml(result.cached?'Cached result':result.model||'OpenAI Codex')}</small></div><p class="ai-why">${escapeHtml(result.whyNow)}</p><div class="ai-replies">${result.suggestedReplies.map((reply,index)=>`<div class="ai-reply"><span>${escapeHtml(reply.style)}</span><p>${escapeHtml(reply.text)}</p><button class="secondary copy-reply" data-reply="${index}" type="button">Copy reply</button></div>`).join('')}</div>`;panel.querySelectorAll('.copy-reply').forEach(button=>button.onclick=async()=>{const original=button.textContent;try{await navigator.clipboard.writeText(result.suggestedReplies[Number(button.dataset.reply)].text);button.textContent='Copied';}catch{button.textContent='Copy failed';}setTimeout(()=>button.textContent=original,1200);});}
async function runAiAssist(post,card){const button=card.querySelector('.ai-assist'),original=button.textContent;button.disabled=true;button.textContent='Thinking…';try{const response=await apiFetch('/api/ai/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({post,profile:state.aiProfile,instructions:state.aiInstructions})}),result=await response.json();if(!response.ok)throw new Error(result.error||'AI Assist failed');state.aiResults.set(postIdentity(post),result);renderAiResult(card,result);}catch(error){renderAiResult(card,{error:error.message||'AI Assist failed. Connect ChatGPT in Settings and try again.'});}finally{button.disabled=false;button.textContent=original;}}
function fmtDate(v){if(!v)return'—';const d=new Date(v);return Number.isNaN(d.getTime())?'—':d.toLocaleString();}
function renderDiagnosticsLegacy(stats){
  const box=$('#diagnostics');
  const list=$('#diagnosticList');
  const ds=stats?.diagnostics||[];
  if(!ds.length){list.innerHTML='<div class="empty"><h2>No diagnostics yet</h2><p>Run a scan to see source requests and response details.</p></div>';return;}
  list.innerHTML=ds.map(d=>{
    if(d.error)return `<div class="diag-item error"><div><strong>${d.platform==='linkedin'?'LinkedIn':'X'} · ${escapeHtml(d.query)}</strong><span>FAILED${d.httpStatus?` · HTTP ${d.httpStatus}`:''}</span></div><pre>${escapeHtml(d.error)}</pre></div>`;
    const body=JSON.stringify(d.requestBody||{});
    return `<div class="diag-item"><div class="diag-head"><strong>${d.platform==='linkedin'?'LinkedIn':'X'} · ${escapeHtml(d.query)}</strong><span>${escapeHtml(d.sku)} · HTTP ${d.httpStatus} · ${d.durationMs||0}ms · $${Number(d.costUsd||0).toFixed(4)}</span></div><div class="diag-grid"><span>Returned <b>${d.returned||0}</b></span><span>Timestamped <b>${d.dated||0}</b></span><span>Missing time <b>${d.missingDate??d.missing??0}</b></span><span>Too old <b>${d.tooOld||0}</b></span><span>Seen <b>${d.alreadySeen||0}</b></span><span>New <b>${d.new||0}</b></span><span>Newest <b>${escapeHtml(fmtDate(d.newest))}</b></span><span>Oldest <b>${escapeHtml(fmtDate(d.oldest))}</b></span></div><details><summary>Request and schema details</summary><pre>Request: ${escapeHtml(body)}\nFirst item fields: ${escapeHtml((d.rawFirstItemKeys||[]).join(', ')||'none')}</pre></details></div>`;
  }).join('');
}

async function screenPostsWithAi(posts){
  const instructions=state.aiInstructions.trim();
  if(!instructions||!posts.length)return{posts,excluded:0,skipped:false,cachedCount:0};
  const result=await screenInBatches(posts,instructions,state.aiProfile,async body=>{
    const response=await apiFetch('/api/ai/screen',{method:'POST',headers:{'Content-Type':'application/json'},body}),result=await response.json();
    if(!response.ok)throw new Error(result.error||'AI screening failed');
    return result;
  });
  if(result.skipped){
    const prior=new Map(state.posts.map(post=>[postIdentity(post),post]));
    result.posts.push(...result.pendingPosts.map(post=>{const cached=prior.get(postIdentity(post));return cached?{...cached,isNew:post.isNew}:null;}).filter(Boolean));
    result.error+=` · ${result.pendingPosts.length} posts awaiting screening`;
  }
  return result;
}
async function performScan(background=false){
  const button=$('#scanButton');
  button.disabled=true;
  button.textContent='Scanning…';
  try{
    const response=await apiFetch('/api/search',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({queriesByPlatform:{x:state.queriesX,linkedin:state.queriesLinkedIn,reddit:state.queriesReddit,youtube:state.queriesYoutube,tiktok:state.queriesTiktok,substack:state.queriesSubstack},platforms:state.platforms,limit:state.limit,maxAgeHours:state.maxAgeHours})
    }),data=await response.json();
    if(!response.ok)throw new Error(data.error||'Scan failed');
    const candidates=data.posts.filter(post=>!isAuthorBlocked(post));
    const screened=await screenPostsWithAi(candidates);
    screened.posts=screened.posts.filter(post=>!isAuthorBlocked(post));
    const returnedKeys=new Set(candidates.map(postIdentity)),acceptedKeys=new Set(screened.posts.map(postIdentity));
    const incomingKeys=new Set(screened.posts.filter(post=>post.isNew!==false).map(postIdentity));
    const retained=state.posts.filter(post=>!returnedKeys.has(postIdentity(post))||acceptedKeys.has(postIdentity(post)));
    state.posts=mergeScanPosts(retained,screened.posts,{maxAgeHours:state.maxAgeHours,hidden:state.hidden});
    const newPosts=state.posts.filter(post=>incomingKeys.has(postIdentity(post))&&!isAuthorBlocked(post));
    const by=data.stats?.byPlatform||{},parts=state.platforms.map(platform=>`${platformNames[platform]} ${by[platform]?.new||0}`);
    const skipped=data.stats?` · ${data.stats.alreadySeen} seen · ${data.stats.tooOld} too old${data.stats.missingDate?` · ${data.stats.missingDate} missing time`:''}`:'';
    const failures=data.stats?.failures?.length?` · ${data.stats.failures.length} source error${data.stats.failures.length>1?'s':''}`:'';
    const aiMeta=screened.skipped?` · AI screening skipped: ${screened.error}`:screened.excluded?` · ${screened.excluded} excluded by AI`:state.aiInstructions.trim()?' · AI screened':'';
    $('#scanMeta').textContent=`${visiblePosts().length} shown · ${newPosts.length} new (${parts.join(' · ')}) · last ${state.maxAgeHours}h · ${data.demo?'Demo data':'Live social data'}${data.costUsd?` · $${data.costUsd.toFixed(4)}`:''}${aiMeta}${skipped}${failures}`;
    render();
    renderDiagnostics(data.stats);
    const enrichmentId=++followerEnrichmentId;
    await enrichFollowers(state.posts,enrichmentId);
    if(background||document.hidden)await notifyFresh(newPosts);
  }catch(error){$('#scanMeta').textContent=error.message;}
  finally{button.disabled=false;button.textContent='Scan now';}
}
async function checkStatus(){try{const response=await apiFetch('/api/status'),s=await response.json();if(!response.ok)throw new Error(s.error||'Key status unavailable');$('#statusDot').classList.toggle('live',s.configured);const labels=state.platforms.map(platform=>platformNames[platform]).join(' + ');$('#statusText').textContent=s.configured?`AnyAPI live · ${labels||'no sources selected'}`:'Demo mode';if(keyStatus){keyStatus.textContent=s.configured?'AnyAPI key saved':'No key saved';keyStatus.className=`key-status ${s.configured?'key-saved':'key-missing'}`;}$('#getAnyApiLink')?.classList.toggle('hidden',s.configured);if($('#appVersion')&&s.version)$('#appVersion').textContent=`RSignals v${s.version}`;}catch{$('#statusText').textContent='Offline';if(keyStatus){keyStatus.textContent='Key status unavailable';keyStatus.className='key-status';}$('#getAnyApiLink')?.classList.add('hidden');}}
async function checkForUpdate(){try{const response=await apiFetch('/api/update',{cache:'no-store'}),result=await response.json();if(!response.ok||!result.checked||!result.updateAvailable){updateBanner.classList.add('hidden');return;}updateVersion.textContent=`v${result.latestVersion}`;downloadUpdate.href=result.releaseUrl;updateBanner.classList.remove('hidden');if(window.signalDesktop&&state.notificationsEnabled&&!inQuietHours()&&localStorage.getItem('signal:updateNotified')!==result.latestVersion){const sent=await window.signalDesktop.notify({title:`RSignals v${result.latestVersion} is available`,body:'Download the latest signed Windows ZIP when it is convenient.',url:result.releaseUrl});if(sent)localStorage.setItem('signal:updateNotified',result.latestVersion);}}catch{}}
function openPost(post){return openExternalUrl(post.url);}
function toggleSave(post){const i=state.saved.findIndex(x=>x.url===post.url);if(i>=0)state.saved.splice(i,1);else state.saved.unshift(post);localStorage.setItem('signal:saved',JSON.stringify(state.saved));render();}
const scan=createScanRunner({run:performScan,isQuiet:inQuietHours,onStart:automatic=>{if(automatic){lastAutoScanAt=Date.now();updateAutoScanStatus();}}});
$('#scanButton').onclick=()=>scan(false);
function saveWatchlists(){const read=el=>el.value.split('\n').map(x=>x.trim()).filter(Boolean);state.queriesX=read(queriesX);state.queriesLinkedIn=read(queriesLinkedIn);state.queriesReddit=read(queriesReddit);state.queriesYoutube=read(queriesYoutube);state.queriesTiktok=read(queriesTiktok);state.queriesSubstack=read(queriesSubstack);state.platforms=[...(platformX.checked?['x']:[]),...(platformLinkedIn.checked?['linkedin']:[]),...(platformReddit.checked?['reddit']:[]),...(platformYoutube.checked?['youtube']:[]),...(platformTiktok.checked?['tiktok']:[]),...(platformSubstack.checked?['substack']:[])];localStorage.setItem('signal:queries:x',JSON.stringify(state.queriesX));localStorage.setItem('signal:queries:linkedin',JSON.stringify(state.queriesLinkedIn));localStorage.setItem('signal:queries:reddit',JSON.stringify(state.queriesReddit));localStorage.setItem('signal:queries:youtube',JSON.stringify(state.queriesYoutube));localStorage.setItem('signal:queries:tiktok',JSON.stringify(state.queriesTiktok));localStorage.setItem('signal:queries:substack',JSON.stringify(state.queriesSubstack));localStorage.setItem('signal:platforms',JSON.stringify(state.platforms));}
$('#saveWatchlists').onclick=async()=>{saveWatchlists();await checkStatus();$('#saveWatchlists').textContent='Saved';setTimeout(()=>$('#saveWatchlists').textContent='Save watchlists',1000);};
$('#saveSettings').onclick=async()=>{state.limit=Math.min(50,Math.max(1,Number(limit.value)||12));state.minFollowers=Math.min(1_000_000_000,Math.max(0,Number(minFollowers.value)||0));state.maxAgeHours=Math.min(168,Math.max(.25,Number(maxAgeHours.value)||3));state.scanInterval=Math.min(240,Math.max(5,Number(scanInterval.value)||15));state.notifyScore=Math.min(99,Math.max(1,Number(notifyScore.value)||70));state.notificationsEnabled=notificationsEnabled.checked;state.quietHoursEnabled=quietHoursEnabled.checked;state.quietStart=quietStart.value||'22:00';state.quietEnd=quietEnd.value||'07:00';state.quietDays=quietDays.filter(day=>day.checked).map(day=>Number(day.value));state.aiInstructions=aiInstructions.value.trim();state.aiProfile=aiProfile.value.trim();localStorage.setItem('signal:limit',String(state.limit));localStorage.setItem('signal:minFollowers',String(state.minFollowers));localStorage.setItem('signal:maxAgeHours',String(state.maxAgeHours));localStorage.setItem('signal:scanInterval',String(state.scanInterval));localStorage.setItem('signal:notifyScore',String(state.notifyScore));localStorage.setItem('signal:notificationsEnabled',String(state.notificationsEnabled));localStorage.setItem('signal:quietHoursEnabled',String(state.quietHoursEnabled));localStorage.setItem('signal:quietStart',state.quietStart);localStorage.setItem('signal:quietEnd',state.quietEnd);localStorage.setItem('signal:quietDays',JSON.stringify(state.quietDays));localStorage.setItem('signal:aiInstructions',state.aiInstructions);localStorage.setItem('signal:aiProfile',state.aiProfile);render();if(window.signalDesktop)await window.signalDesktop.setStartup(startWithWindows.checked);scheduleAutomaticScan();await checkStatus();await checkAiStatus();$('#saveSettings').textContent='Saved';setTimeout(()=>$('#saveSettings').textContent='Save settings',1000);};
connectChatGPT.onclick=async()=>{connectChatGPT.disabled=true;connectChatGPT.textContent='Opening sign in…';try{const response=await apiFetch('/api/ai/login/chatgpt',{method:'POST'}),result=await response.json();if(!response.ok)throw new Error(result.error||'Could not start ChatGPT sign in.');await openExternalUrl(result.authUrl);connectChatGPT.textContent='Waiting for sign in…';pollForAiConnection();}catch(error){aiStatusDetail.textContent=error.message||'Could not start ChatGPT sign in.';connectChatGPT.disabled=false;connectChatGPT.textContent='Connect ChatGPT';}};
disconnectAi.onclick=async()=>{disconnectAi.disabled=true;try{const response=await apiFetch('/api/ai/logout',{method:'POST'}),result=await response.json();if(!response.ok)throw new Error(result.error||'Could not disconnect AI Assist.');applyAiStatus(result);}catch(error){aiStatusDetail.textContent=error.message||'Could not disconnect AI Assist.';}finally{disconnectAi.disabled=false;}};
saveOpenAiKey.onclick=async()=>{const key=openAiApiKey.value.trim();if(!key)return;saveOpenAiKey.disabled=true;saveOpenAiKey.textContent='Connecting…';try{const response=await apiFetch('/api/ai/login/key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:key})}),result=await response.json();openAiApiKey.value='';if(!response.ok)throw new Error(result.error||'Could not connect the OpenAI API key.');applyAiStatus(result);saveOpenAiKey.textContent='Connected';}catch(error){openAiApiKey.value='';aiStatusDetail.textContent=error.message||'Could not connect the OpenAI API key.';saveOpenAiKey.textContent='Use API key';}finally{saveOpenAiKey.disabled=false;setTimeout(()=>{if(saveOpenAiKey.textContent==='Connected')saveOpenAiKey.textContent='Use API key';},1200);}};
$('#testNotification').onclick=async()=>{const button=$('#testNotification'),original=button.textContent;button.disabled=true;try{const sent=window.signalDesktop&&await window.signalDesktop.notify({title:'RSignals notifications are working',body:'You will receive alerts when automatic scans find new posts above your minimum fit score.'});button.textContent=sent?'Test sent':'Notifications unavailable';}catch{button.textContent='Notifications unavailable';}finally{setTimeout(()=>{button.disabled=false;button.textContent=original;},1800);}};
$$('.tab').forEach(t=>t.onclick=()=>{$$('.tab').forEach(x=>x.classList.remove('active'));t.classList.add('active');state.filter=t.dataset.filter;render();}); $$('.nav').forEach(n=>n.onclick=()=>{$$('.nav').forEach(x=>x.classList.remove('active'));n.classList.add('active');['feed','saved','watchlists','settings'].forEach(v=>$(`#${v}View`).classList.toggle('hidden',v!==n.dataset.view));if(n.dataset.view==='settings')void checkAiStatus();requestAnimationFrame(refreshPostOverflow);});
$('#saveKey').onclick=async()=>{const key=$('#apiKey').value.trim();if(!key)return;const response=await apiFetch('/api/key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})}),data=await response.json();if(!response.ok){$('#statusText').textContent=data.error||'Could not save key';return;}$('#apiKey').value='';await checkStatus();$('#saveKey').textContent='Saved';setTimeout(()=>$('#saveKey').textContent='Save key',1000);};
document.addEventListener('click',event=>{const link=event.target.closest('a[href]');if(link&&window.signalDesktop){event.preventDefault();void openExternalUrl(link.href);}});
function focusNotificationOpportunity(payload={}){document.querySelector('.nav[data-view="feed"]')?.click();const key=String(payload.postKey||'');if(!key)return;requestAnimationFrame(()=>{const card=[...document.querySelectorAll('#feed .card')].find(item=>item.dataset.postKey===key);if(!card)return;card.scrollIntoView({behavior:'smooth',block:'center'});card.classList.add('toast-focus');setTimeout(()=>card.classList.remove('toast-focus'),2200);});}
if(window.signalDesktop){window.signalDesktop.onTriggerScan(()=>scan(false));window.signalDesktop.onNotificationClick(focusNotificationOpportunity);}scheduleAutomaticScan();

const baseRenderCard=renderCard;
renderCard=(post,showHide=true)=>{const card=baseRenderCard(post,showHide),time=card.querySelector('.time');if(time)time.dataset.createdAt=post.createdAt||'';return card;};
function refreshRelativeTimes(){if(pruneExpiredPosts()){render();return;}document.querySelectorAll('.time[data-created-at]').forEach(time=>{time.textContent='· '+minutesAgo(time.dataset.createdAt);});}
setInterval(refreshRelativeTimes,30000);
setInterval(checkForUpdate,updateCheckIntervalMs);
window.addEventListener('resize',refreshPostOverflow);
window.addEventListener('beforeunload',stopAiPolling);
function renderDiagnostics(){}
function hidePost(post){const key=postIdentity(post);if(!state.hidden.includes(key))state.hidden.unshift(key);localStorage.setItem('signal:hidden',JSON.stringify(state.hidden));render();}
function updateCounts(){const count=visiblePosts().length;$('#navCount').textContent=count;$('#savedCount').textContent=state.saved.length;const meta=$('#scanMeta');meta.textContent=String(meta.textContent||'').replace(/^\d+ shown/,`${count} shown`);}
function format(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(n)} function escapeHtml(s=''){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}


render();
void scan(true);
