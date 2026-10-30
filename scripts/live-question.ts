import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { verifyMaterials } from "./live-materials.ts";

// A real AskUserQuestion stream below the gate, with real reviewer calls and dialog dispatch.
export function questionFixture(mode: string, artifacts: string): string {
  if (!mode.startsWith("question-")) return "";
  return `if(!e.agentId && first){
    const bad=first && ${JSON.stringify(mode)}!=='question-pass';first=false;
    let text=bad && ${JSON.stringify(mode)}==='question-revise'?'The fact.txt release channel is beta. CERBERUS_REJECTED_DRAFT':'stable is the current channel in fact.txt. Choose the channel for future updates: Stable (recommended) keeps tested production releases for reliability; Beta receives earlier preview features with less testing and higher regression risk.';
    const input={questions:[{question:'Which release channel should be used for future updates?',header:'Channel',options:[{label:'Stable (Recommended)',description:'Keep tested production releases for reliability',preview:'Future updates stay on tested production releases, recommended for reliability.'},{label:'Beta',description:'Receive earlier preview features with less testing and higher regression risk'}],multiSelect:false}]};
    if(bad && ${JSON.stringify(mode)}==='question-context')text='As discussed in earlier turns, choose the channel.';
    if(bad && ${JSON.stringify(mode)}==='question-order')input.questions[0].options.reverse();
    if(bad && ${JSON.stringify(mode)}==='question-editorial')text+=' I corrected the unpublished draft from beta to stable. Here is the revised question.';
    const tool={name:'AskUserQuestion',input};
    await $.fs.write(${JSON.stringify(artifacts)}+'/question-generated-'+e.turnId+'-'+e.index+'.json',JSON.stringify({text,input}));
    yield {kind:'text',index:0,text};yield {kind:'tool',index:1,id:'question-'+e.turnId+'-'+e.index,name:tool.name};yield {kind:'input',index:1,json:JSON.stringify(input)};yield {kind:'stop',stopReason:'tool_use',usage:null};
    return {turnId:e.turnId,index:e.index,answer:text,toolUses:[tool],stopReason:'tool_use',usage:null};
   }`;
}

export async function verifyQuestion(artifacts: string, mode: string, screen: string) {
  const records = await readdir(artifacts);
  const reviews = await Promise.all(
    records
      .filter((name) => /^review-\d+\.json$/u.test(name))
      .map(async (name) => JSON.parse(await readFile(join(artifacts, name), "utf8"))),
  );
  const decisions = reviews.map((review) => {
    try {
      return JSON.parse(review.result.text).decision;
    } catch {
      return undefined;
    }
  });
  if (!decisions.includes("PASS")) throw new Error("Question did not pass real review");
  if (mode !== "question-pass" && !decisions.includes("REVISE"))
    throw new Error("Question defect was not revised");
  if (screen.includes("CERBERUS_REJECTED_DRAFT")) throw new Error("Rejected explanation leaked");
  const dispatched = JSON.parse(
    await readFile(join(artifacts, "question-dispatched.json"), "utf8"),
  );
  const approved = reviews.find((review) => {
    try {
      return JSON.parse(review.result.text).decision === "PASS";
    } catch {
      return false;
    }
  });
  const draft = JSON.parse(JSON.parse(approved.request.prompt.split("\n")[0]).unpublishedDraft);
  if (
    mode !== "question-pass" &&
    /(?:previous|unpublished) draft|revised question|修正版|前回の原稿|修正(?:点|箇所|経緯)/iu.test(
      draft.explanation,
    )
  )
    throw new Error("Approved explanation narrates unpublished-draft edits");
  if (
    mode === "question-editorial" &&
    !reviews.some((review) => {
      try {
        const verdict = JSON.parse(review.result.text);
        return (
          verdict.decision === "REVISE" &&
          verdict.findings.some((finding: string) =>
            /unpublished|revision|narrat|修正経緯|未公開/iu.test(finding),
          )
        );
      } catch {
        return false;
      }
    })
  )
    throw new Error("Reviewer did not flag unpublished-draft narration");
  if (JSON.stringify(dispatched.questions) !== JSON.stringify(draft.toolUses[0].input.questions))
    throw new Error("Displayed question differs from approved inputs");
  if (!screen.includes("[PASS]") || !screen.includes("stable"))
    throw new Error("Approved explanation or notice missing");
  await verifyMaterials(records, artifacts, mode);
}
