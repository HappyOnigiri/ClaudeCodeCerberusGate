import { join } from "node:path";
import { drafts } from "./live-scenarios.ts";
import { questionFixture } from "./live-question.ts";
import { forkFixture } from "./live-fork.ts";

export function liveFixture(
  mode: string,
  artifacts: string,
  useFork: boolean,
  cliCommand: string,
  work: string,
): string {
  return `
 let first=true,review=0,prompts=0,tools=0,userPrompts=0,materials=0;const seenMaterials=new Set();
 export const register=on=>{
  if(${JSON.stringify(mode)}==='cli')on('tool.list',async($,e,next)=>{const r=await next(e);return {...r,value:r.value.filter(t=>t.name!=='Grep')};});
  ${useFork ? forkFixture(mode, artifacts) : ""}
  on('turn.step',async function*($,e,next){
   ${useFork ? "" : questionFixture(mode, artifacts)}
   if(!${useFork} && !e.agentId && first && (['revise','cap','reload-review','bounds','environment','causal','choice'].includes(${JSON.stringify(mode)}) || (${JSON.stringify(mode)}==='history' && userPrompts>=2))){
    first=false;
    const text=${JSON.stringify(mode)}==='history'?'The limit is 8. CERBERUS_REJECTED_DRAFT':${JSON.stringify(drafts[mode] ?? "The release channel is beta. CERBERUS_REJECTED_DRAFT")};
    yield {kind:'text',index:0,text};yield {kind:'stop',stopReason:'end_turn',usage:null};
    return {turnId:e.turnId,index:e.index,answer:text,toolUses:[],stopReason:'end_turn',usage:null};
   }
   const stream=next(e);const pieces=[];for await(const c of stream){pieces.push(c);if(!${useFork} && ${JSON.stringify(mode)}!=='history')yield c;}
   let result=await stream.result;
   if(${useFork}) {
     ${useFork ? questionFixture(mode, artifacts).replace("if(!e.agentId && first)", "if(!e.agentId && first && (result.toolUses.length===0 || result.toolUses.some(t=>t.name==='AskUserQuestion')))") : ""}
     if(!e.agentId && first && result.toolUses.length===0 && ['revise','cap'].includes(${JSON.stringify(mode)})) {
       first=false;const text='The release channel is beta. CERBERUS_REJECTED_DRAFT';
       pieces.splice(0,pieces.length,{kind:'text',index:0,text},{kind:'stop',stopReason:'end_turn',usage:result.usage});result={...result,answer:text};
     }
     yield* pieces;
   }
   if(${JSON.stringify(mode)}==='history'){
    if(!e.agentId && userPrompts===1 && result.toolUses.length===0){
     const text='ORCHID ACK'; pieces.splice(0,pieces.length,{kind:'text',index:0,text},{kind:'stop',stopReason:'end_turn',usage:null});result={...result,answer:text};
    }
    yield* pieces;
   }
   await $.fs.write(${JSON.stringify(artifacts)}+'/step-'+(e.agentId??'main')+'-'+e.turnId+'-'+e.index+'.json',JSON.stringify({event:e,result,pieces}));
   return result;
  });
  on('prompt.submit',async($,e,next)=>{
   if(e.origin.kind==='composer')userPrompts++;
   const result=await next(e);await $.fs.write(${JSON.stringify(artifacts)}+'/prompt-'+(++prompts)+'.json',JSON.stringify({...e,context:result.context??e.context}));return result;
  });
  on('model.complete',async($,e,next)=>{
   if(${useFork})throw new Error('Fork unexpectedly called complete');
   const index=++review;
   const material=JSON.parse(e.prompt).sessionLog;
   if(!seenMaterials.has(material.source)){
    seenMaterials.add(material.source);
    const raw=await $.fs.read(material.source), original=await $.fs.read(material.sourcePath);
    if(!original.startsWith(raw))throw new Error('Source prefix changed');
    await $.fs.write(${JSON.stringify(artifacts)}+'/material-'+(++materials)+'.json',JSON.stringify({material,raw,users:await $.fs.read(material.users),history:await $.fs.read(material.history)}));
   }
   if(${JSON.stringify(mode)}==='reload-review' && !(await $.fs.exists(${JSON.stringify(artifacts)}+'/reloaded'))){
    await $.fs.write(${JSON.stringify(artifacts)}+'/reload-ready','review');await $.clock.sleep(7000);
   }
   await $.fs.write(${JSON.stringify(artifacts)}+'/review-start-'+index+'.json',JSON.stringify({at:Date.now(),request:e}));
   if(['cancel','timeout'].includes(${JSON.stringify(mode)}))await $.clock.sleep(7000);
   if(${JSON.stringify(mode)}==='slow')await $.clock.sleep(6000);
   if(${JSON.stringify(mode)}==='cli')e={...e,prompt:e.prompt+'\\nBefore deciding, request Bash with command '+${JSON.stringify(JSON.stringify(cliCommand))}+' to inspect the latest commit subject. The evidence array must contain this successful CLI output AND a successful read-only Bash grep search of sessionLog.history that returns matching lines. Grep is not listed; do not request it. Verify both the release channel and evidence token in the draft against that output. Do not substitute file reads. If this command is already in evidence, use it and decide; do not repeat it.'};
   if(${JSON.stringify(mode)}==='history' && JSON.parse(e.prompt).unpublishedDraft.includes('CERBERUS_REJECTED_DRAFT'))e={...e,prompt:e.prompt+'\\nBefore deciding, the evidence array must contain both a successful Grep on sessionLog.history with output_mode content and a successful Read of narrow matching history.txt ranges around the prior LIMIT tool result. Do not substitute a read of limits.ts for reading history.txt. Do not decide based solely on the current draft or request.'};
   if(${JSON.stringify(mode)}==='recover')e={...e,prompt:e.prompt+'\\nBefore deciding, after the required sessionLog.users Read, the evidence array must also contain a Read of '+${JSON.stringify(join(work, "missing-fact.txt"))}+' (it may not exist) followed by a successful Read of fact.txt. If the missing-file Read is already in evidence, request Read of fact.txt next; if both exist, return the verdict. Do not repeat completed reads.'};
   if(${JSON.stringify(mode)}==='search')e={...e,prompt:e.prompt+'\\nBefore deciding, the evidence array must contain successful results from both Glob (find **/fact.txt) and Grep (search stable in fact.txt). If Glob is already in evidence, request Grep next; if both exist, return the verdict. Do not repeat completed searches.'};
   if(${JSON.stringify(mode)}.startsWith('question-'))e={...e,prompt:e.prompt+'\\nBefore deciding, your evidence array must contain successful Read results for sessionLog.users and fact.txt. If missing, request those reads first, one at a time; do not repeat successful reads. Use Read or Grep for this fixture rather than Bash.'};
   const result=${JSON.stringify(mode)}==='cap'
    ? {value:{isAnswered:true,text:JSON.stringify({decision:'REVISE',findings:['fact.txt:1 says stable; correct the beta release channel.']}),usage:{input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}}
    : ${JSON.stringify(mode)}==='unverified'
    ? {value:{isAnswered:true,text:'INVALID_REVIEW',usage:{input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}}
    : await next(e);
   await $.fs.write(${JSON.stringify(artifacts)}+'/review-'+index+'.json',JSON.stringify({request:e,result:result.value,at:Date.now()}));
   return result;
  });
  on('tool.call',async($,e,next)=>{
   if(e.tool==='AskUserQuestion')await $.fs.write(${JSON.stringify(artifacts)}+'/question-dispatched.json',JSON.stringify(e));
   const result=await next(e);
   if(e.tool==='Read' && !e.agentId && next.origin.plugin!=='cerberus-gate' && ${JSON.stringify(mode)}==='reload-work' && !(await $.fs.exists(${JSON.stringify(artifacts)}+'/reloaded'))){
    await $.fs.write(${JSON.stringify(artifacts)}+'/reload-ready','work');for(let wait=0;wait<100 && !(await $.fs.exists(${JSON.stringify(artifacts)}+'/reload-confirmed'));wait++)await $.clock.sleep(250);
   }
   await $.fs.write(${JSON.stringify(artifacts)}+'/tool-'+(++tools)+'.json',JSON.stringify({tool:e.tool,input:e,origin:next.origin,result}));return result;
  });
  on('turn.complete',async($,e,next)=>{
   await $.fs.write(${JSON.stringify(artifacts)}+'/complete-'+e.turnId+'.json',JSON.stringify(e));return next(e);
  });
  on('session.end',async($,e,next)=>{
   await $.fs.write(${JSON.stringify(artifacts)}+'/session-end.json',JSON.stringify(e));return next(e);
  });
 };
 `;
}
