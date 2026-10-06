// Real Chromium HTTP transport; generated credentials and localhost model fixtures only.
import { app, net, session } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDesktopFetch } from '../electron/desktop-fetch.js';
import { createConfiguredModel } from '../electron/model.js';
import { McpRegistry } from '../electron/mcp-registry.js';
import { McpManager } from '../electron/mcp.js';
import { startHttpMcpServer } from './http-mcp-server.js';
async function main() {
 const root=await mkdtemp(path.join(os.tmpdir(),'meihua-network-')); app.setPath('userData',root);
 await app.whenReady();
 const fetcher=createDesktopFetch((input,options)=>net.fetch(input,options));
 const calls=[];
 const server=createServer(async(req,res)=>{
  if(req.url==='/redirect'){res.writeHead(302,{location:'/target'}).end();return;}
  if(req.url==='/target'){calls.push('redirect-target');res.end('unsafe');return;}
  if(req.url==='/slow')return;
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);const pathname=new URL(req.url,'http://localhost').pathname;calls.push({path:pathname,model:body.model,cookie:req.headers.cookie});
  res.writeHead(200,{'content-type':'text/event-stream'});
  const sse=(event,data)=>res.write(`${event?'event: '+event+'\n':''}data: ${JSON.stringify(data)}\n\n`);
  if(pathname.endsWith('/chat/completions')){
   sse(null,{id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'network verified'},finish_reason:null}]});
   sse(null,{id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:2,total_tokens:7}});res.write('data: [DONE]\n\n');
  }else if(pathname.endsWith('/messages')){
   sse('message_start',{type:'message_start',message:{id:'fixture',type:'message',role:'assistant',model:'fixture',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:5,output_tokens:0}}});
   sse('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}});
   sse('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'network verified'}});
   sse('content_block_stop',{type:'content_block_stop',index:0});
   sse('message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:2}});
   sse('message_stop',{type:'message_stop'});
  }else{
   const item={id:'msg_1',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'network verified',annotations:[]}]};
   sse('response.created',{type:'response.created',response:{id:'fixture',status:'in_progress',output:[]}});
   sse('response.output_item.added',{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}});
   sse('response.output_text.delta',{type:'response.output_text.delta',item_id:'msg_1',output_index:0,content_index:0,delta:'network verified'});
   sse('response.output_item.done',{type:'response.output_item.done',output_index:0,item});
   sse('response.completed',{type:'response.completed',response:{id:'fixture',status:'completed',output:[item],usage:{input_tokens:5,output_tokens:2,total_tokens:7}}});
  }
  res.end();
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 let httpMcp;
 try {
  await session.defaultSession.cookies.set({ url: base, name: 'desktop-session', value: 'fixture-cookie' });
  for(const provider of ['compatible','openai','anthropic']){
   const configured=createConfiguredModel({provider,model:'fixture',baseUrl:provider==='anthropic'?base:base+'/v1'},'fixture-key',{},fetcher);
   const stream=configured.streamFn(configured.model,{messages:[{role:'user',content:'verify transport',timestamp:Date.now()}]},{signal:AbortSignal.timeout(5000)});
   const result=await stream.result(); assert.equal(result.stopReason,'stop',result.errorMessage);assert.equal(result.content.filter(b=>b.type==='text').map(b=>b.text).join(''),'network verified');
  }
  assert.deepEqual(calls.map(c=>c.path),['/v1/chat/completions','/v1/responses','/v1/messages']);assert.ok(calls.every(c=>!c.cookie));
  await assert.rejects(fetcher(base+'/redirect',{redirect:'error'}));assert.equal(calls.includes('redirect-target'),false);
  await assert.rejects(fetcher(base+'/slow',{signal:AbortSignal.timeout(100)}));
  await assert.rejects(async()=>fetcher('file:///etc/hosts'));
  console.log('PASS Chromium fetch streams all three model protocols, preserves abort and redirect refusal, omits cookies and rejects file URLs');
  httpMcp=await startHttpMcpServer();const manager=new McpManager(root,{tools:{transport:'http',url:httpMcp.url,headers:{Authorization:'Bearer local-test-token'}}},async()=>true,{fetcher});
  try{assert.ok((await manager.listTools('tools')).some(t=>t.name==='echo'));assert.match(JSON.stringify(await manager.callTool('tools','echo',{text:'chromium'})),/http:chromium/);}finally{await manager.close();}
  console.log('PASS configured MCP HTTP connection and actual tool result use Chromium fetch');
  if(process.argv.includes('--live-registry')){
   const result=await new McpRegistry(fetcher).search('网页');assert.ok(result.servers.length>0);console.log('PASS live official MCP registry search:',result.servers.length,'results');
  }
  app.exitCode=0;
 }catch(error){console.error(error);app.exitCode=1;}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await httpMcp?.close();await rm(root,{recursive:true,force:true});app.exit(app.exitCode);}
}
main().catch(error=>{console.error(error);app.exit(1);});
