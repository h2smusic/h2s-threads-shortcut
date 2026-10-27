// H2S Threads public post media extractor. Runs as a Vercel Function.
// Does not accept arbitrary destinations, cookies, credentials or private posts.
const HOSTS = new Set(['www.threads.com','threads.com','www.threads.net','threads.net']);
function parseLink(input) {
  if (typeof input !== 'string' || input.length > 1800) throw Error('Threads 링크를 입력해주세요.');
  const match = input.match(/https?:\/\/(?:www\.)?threads\.(?:com|net)\/[^\s<>"']+/i);
  if (!match) throw Error('유효한 Threads 게시물 링크가 아닙니다.');
  const u = new URL(match[0].replace(/[),.;]+$/, ''));
  if (!HOSTS.has(u.hostname.toLowerCase()) || !['https:', 'http:'].includes(u.protocol) || u.port || u.username || u.password) throw Error('Threads 링크만 지원합니다.');
  u.protocol='https:';
  return u;
}
function postCode(url) {
  return url.pathname.match(/\/(?:@[^/]+\/post|t)\/([\w-]+)/i)?.[1] || null;
}
function htmlUnescape(s) {
  return String(s || '').replace(/&amp;/g,'&').replace(/&#0?64;/g,'@').replace(/&#39;/g,"'").replace(/&quot;/g,'"');
}
function collectPosts(node, out, depth=0) {
  if (!node || depth > 80 || out.length > 450) return;
  if (Array.isArray(node)) { for(const item of node) collectPosts(item,out,depth+1);return; }
  if (typeof node!=='object') return;
  if (typeof node.code==='string' && (node.video_versions || node.image_versions2 || node.carousel_media || node.text_post_app_info)) out.push(node);
  for(const item of Object.values(node)) if(item && typeof item==='object')collectPosts(item,out,depth+1);
}
function mediaFrom(post) {
  if (!post || typeof post!=='object') return [];
  const entries=Array.isArray(post.carousel_media) && post.carousel_media.length ? post.carousel_media : [post];
  const out=[];
  for(const item of entries) {
    const video=(Array.isArray(item?.video_versions) ? item.video_versions : []).filter(x=>x?.url).sort((a,b)=>(b.width||0)*(b.height||0)-(a.width||0)*(a.height||0))[0]?.url;
    const pics=Array.isArray(item?.image_versions2?.candidates) ? item.image_versions2.candidates: [];
    const image=pics.filter(x=>x?.url).sort((a,b)=>(b.width||0)*(b.height||0)-(a.width||0)*(a.height||0))[0]?.url;
    const url=video || image;
    if (typeof url==='string' && /^https:\/\//i.test(url)) out.push({url:htmlUnescape(url),type:video?'video':'image'});
  }
  return out;
}
async function getHTML(input){
 const r=await fetch(input,{
  headers:{"User-Agent":"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)","Accept":"text/html,application/xhtml+xml","Accept-Language":"en-US,en;q=0.8"},
  redirect:"follow", signal:AbortSignal.timeout(15000),cache:"no-store"
 });
 if(!r.ok)throw Error('Threads 웹페이지 연결 오류 (HTTP '+r.status+')');
 if(!HOSTS.has(new URL(r.url).hostname))throw Error('Threads 이외 사이트로 이동했습니다.');
 const html=await r.text();
 if(html.length>6000000)throw Error('게시물 데이터가 너무 큽니다.');
 return {html,finalURL:r.url};
}
export default async function handler(req,res){
 res.setHeader('Access-Control-Allow-Origin','*');
 res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
 res.setHeader('Access-Control-Allow-Headers','Content-Type');
 res.setHeader('Cache-Control','no-store');
 if(req.method==='OPTIONS')return res.status(204).end();
 if(req.method!=='GET')return res.status(405).json({ok:false,error:'GET만 지원합니다.',urls:[]});
 try{
  let input=parseLink(req.query.url);
  const {html,finalURL}=await getHTML(input.toString());
  const canonical=htmlUnescape(html.match(/<meta[^>]*property=["']og:url["'][^>]*content=["']([^"']+)/i)?.[1] ||
                               html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:url["']/i)?.[1] || '');
  const code=postCode(input)||postCode(new URL(finalURL))||(canonical ? postCode(new URL(canonical)):null);
  if(!code) return res.status(200).json({ok:false,error:'게시물 주소를 식별하지 못했습니다. Threads 게시물의 링크 복사를 이용해주세요.',reason:'NO_POST_CODE',urls:[]});
  const scripts=[...html.matchAll(/<script\b(?=[^>]*\btype\s*=\s*["']application\/json["'])[^>]*>([\s\S]*?)<\/script\s*>/gi)];
  const posts=[];
  for(const m of scripts){
   try{collectPosts(JSON.parse(m[1]),posts)}catch{}
  }
  const post=posts.find(p=>p.code===code);
  if(!post){
   return res.status(200).json({ok:false,error:'현재 Threads 응답에서 해당 게시물 데이터를 찾지 못했습니다. 비공개/삭제 게시물이거나 접근이 제한된 것일 수 있습니다.',reason:'POST_NOT_FOUND',urls:[],code,postsSeen:posts.length});
  }
  let media=mediaFrom(post);
  if(!media.length){
   const info=post.text_post_app_info||{};
   for(const linked of [info.linked_inline_media,info.share_info?.quoted_attachment_post,info.share_info?.quoted_post]){
    if(linked && (media=mediaFrom(linked)).length)break;
   }
  }
  media=media.filter((m,i,all)=>all.findIndex(x=>x.url===m.url)===i).slice(0,20);
  if(!media.length)return res.status(200).json({ok:false,error:'게시물에 저장 가능한 공개 미디어가 없습니다.',reason:'NO_MEDIA',urls:[],code});
  return res.status(200).json({ok:true,urls:media.map(x=>x.url),types:media.map(x=>x.type),count:media.length,code,canonical:canonical||finalURL,version:'2026-10-28-v2'});
 }catch(e){return res.status(200).json({ok:false,error:e?.message||'알 수 없는 오류',reason:'FETCH_ERROR',urls:[],version:'2026-10-28-v2'});}
}
