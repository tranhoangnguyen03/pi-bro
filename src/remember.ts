/** Private, user-controlled workflow for approved personal memories. No durable unfinished drafts. */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execute as executeBackend } from "./backend.ts";
import { BtwModal, formatBtwTranscript } from "./btw.ts";
import { openBroOverlay } from "./modal-kit.ts";
import { captureShowTranscript } from "./show.ts";
import { readPreferences, readSettings, selectionForCapability, selectionLabel, capabilityBackend } from "./settings.ts";
import {
  changeMemory, readMemoryStore, renderUserMemory,
  type MemoryEntry, type MemoryStore,
} from "./remember-store.ts";
import {
  buildRememberPrompt, makeReviewedProposal, parseRememberResult, staleProposalReview,
  type RememberProposal, type RememberTurn,
} from "./remember-engine.ts";
import { errorMessage } from "./util.ts";

const HELP = [
  "## Remember Me", "",
  "Talk naturally; Bro may ask a focused question or propose a qualified memory. /save approves **exactly** what is displayed.",
  "/save — approve proposal, or show changes in the store that need new approval",
  "/confirm-revision — after examining stale changes, approve the reviewed proposal against that revision",
  "/list [page] — browse all memories (20 per page); refresh without losing the proposal",
  "/search <words> — search approved memory fields",
  "/expand <id> — unfold a memory; /edit <id> — start an update; /delete <id> — confirm deletion",
  "/context show|on|off — inspect, include or omit captured Pi context from model calls",
  "/new — intentionally discard current unfinished work; /help — show these commands",
  "",
  "Drafts last while this window stays open. Approved entries survive restarts. Legacy /bro preferences remain a separate style file.",
].join("\n");

function memoryDetail(m?: MemoryEntry): string {
  if (!m) return "(entry absent)";
  return m.title+": "+m.summary+
    (m.scope ? "\nScope: "+m.scope : "")+
    (m.exceptions ? "\nExceptions: "+m.exceptions : "")+
    (m.uncertainty ? "\nUNRESOLVED: "+m.uncertainty : "")+
    "\nBackground: "+m.background+
    (m.sourceContext ? "\nSource context: "+m.sourceContext : "")+
    "\nBasis: "+(m.basis??"user-stated");
}

export async function openRememberModal(ctx: ExtensionCommandContext, initial = ""): Promise<void> {
  let store = await readMemoryStore();
  const capturedContext = captureShowTranscript(ctx, 8, 12000)?.text ?? "";
  const openingSettings = await readSettings();
  const openingSelection = selectionForCapability(openingSettings, "btw");
  await openBroOverlay<void>(ctx, (tui, theme, _keys, done) => {
    let closed = false;
    let controller: AbortController | undefined;
    let busy = false;
    let proposal: RememberProposal | undefined;
    let transcript: RememberTurn[] = [];
    let relatedQuestionIds: string[] = [];
    let confirmingDelete: string | undefined;
    let contextEnabled = true;
    let page = 0;
    let query = "";
    let browserText = "";
    let selectedBackend = openingSelection.backend ?? "agy";
    let selectedModel = selectionLabel(openingSelection);
    const close = () => { if (closed) return; closed = true; controller?.abort(); done(undefined); };
    const modal = new BtwModal(tui, theme, close, submit, () => { closed = true; controller?.abort(); }, {
      title:"Bro · remember-me", commands:"", inputLabel:"Your memory or correction",
      idleHint:"Enter discuss · /save approve · /context show · /help",
    });
    const header = () => "## Writing a memory\n\n**Model:** "+selectedModel+" ("+selectedBackend+
      "). **Recent Pi context:** "+(contextEnabled ? "ON ("+capturedContext.length+" characters, at most 8 turns)" : "OFF")+
      ".\n\nDrafting also shares relevant saved memories and the legacy Bro preference text with the selected provider."+
      " /context show displays the captured Pi text; /context off omits it. Current user requests outrank stored guidance.";
    const proposalText = () => {
      if (!proposal) return "";
      const d = proposal.draft;
      return "## Reviewed proposal — "+(proposal.action==="update" ? "UPDATE "+proposal.targetId : "CREATE new memory")+
        "\n\n**"+d.title+": "+d.summary+"**"+
        (d.scope ? "\n\nScope: "+d.scope : "")+
        (d.exceptions ? "\n\nExceptions: "+d.exceptions : "")+
        (d.uncertainty ? "\n\n**UNRESOLVED:** "+d.uncertainty : "")+
        "\n\nBackground: "+d.background+
        (d.sourceContext ? "\n\nSource context: "+d.sourceContext : "")+
        "\n\nBasis: "+(d.basis??"user-stated")+
        (proposal.relatedIds.length ? "\n\nRelated IDs: "+proposal.relatedIds.join(", ") : "")+
        "\n\nReviewed against store revision: "+proposal.reviewedRevision+
        "\n\n**/save** approves this exact content; reply to correct it.";
    };
    const staleText = () => {
      const review = proposal?.staleReview;
      if (!review) return "";
      return "## Store changed since proposal review\n\nOriginal revision: "+proposal!.reviewedRevision+
        " · Current revision: "+review.revision+
        "\n\n**Original target:**\n\n"+memoryDetail(review.previousTarget)+
        "\n\n**Current target:**\n\n"+memoryDetail(review.currentTarget)+
        (review.related.length ? "\n\n**Current related entries:**\n\n"+review.related.map(memoryDetail).join("\n\n") : "")+
        "\n\nReview the differences and the proposed replacement below. "+
        (proposal!.action==="update" && !review.currentTarget
          ? "The update target was deleted; this proposal cannot overwrite it. Discuss a new create action."
          : "Type **/confirm-revision** to approve against the current revision, or reply to revise. "+
            "If another write occurs, you must review again.");
    };
    const show = (message = "") => {
      const conversation = transcript.length
        ? formatBtwTranscript(transcript.map(t=>({question:t.user,
            answer:t.bro.startsWith('{"kind":"proposal"') ? "Bro proposed memory wording; review the current draft below." : t.bro}))) : "";
      // Put proposal last: scrolling to end exposes the exact text being approved.
      const questionLinks = relatedQuestionIds.length ? "Related memory IDs: "+relatedQuestionIds.join(", ") : "";
      const content = [header(), message||browserText, questionLinks, conversation, staleText(), proposalText()].filter(Boolean).join("\n\n---\n\n");
      modal.setText(content);
      modal.scrollToEnd();
    };
    const refresh = async (offset=0, search="") => {
      const latest = await readMemoryStore();
      store=latest; page=Math.max(0,offset); query=search;
      // No proposal mutation on list/search/refresh. A stale proposal retains its reviewedRevision.
      browserText=renderUserMemory(store,{query,offset:page,limit:20});
      show();
    };
    const save = async (reapproved = false) => {
      if (!proposal || busy) { modal.setNotice("No proposal to save.", "warning"); return; }
      busy = true; modal.setRunning(true);
      try {
        const latest=await readMemoryStore();
        store=latest;
        if (reapproved) {
          const pending=proposal.staleReview;
          if (!pending) { modal.setNotice("No changed revision under review. Use /save.", "warning"); return; }
          if (pending.revision!==latest.revision) {
            proposal.staleReview=staleProposalReview(proposal,latest);
            show();
            modal.setNotice("Store changed again. Compare and type /confirm-revision again.", "warning");
            return;
          }
        } else if (latest.revision!==proposal.reviewedRevision) {
          proposal.staleReview=staleProposalReview(proposal,latest);
          show();
          modal.setNotice("Store changed. Review original and current entries before /confirm-revision.", "warning");
          return;
        }
        const expectedRevision=reapproved ? proposal.staleReview!.revision : proposal.reviewedRevision;
        if (proposal.action==="update" && !latest.entries.some(m=>m.id===proposal!.targetId)) {
          modal.setNotice("Update target was deleted. No write occurred; discuss creating a new entry.", "error");
          return;
        }
        const id=proposal.targetId;
        store=await changeMemory({kind:"save",draft:proposal.draft,...(id ? {id} : {})},expectedRevision);
        const savedId=id??store.entries.at(-1)?.id??"";
        proposal=undefined; transcript=[]; relatedQuestionIds=[]; browserText=renderUserMemory(store);
        show(); modal.setNotice("Saved "+savedId+" exactly as approved.", "success");
      } catch(e) { modal.setNotice(errorMessage(e), "error"); }
      finally { busy=false; if(!closed)modal.setRunning(false); }
    };
    const ask = async (input:string) => {
      if (busy||closed) return;
      busy=true;
      const attempt=new AbortController();
      controller=attempt; modal.setRunning(true);
      try {
        store=await readMemoryStore();
        const [settings,preferences]=await Promise.all([readSettings(),readPreferences()]);
        const backend=capabilityBackend(settings,"btw");
        selectedBackend=backend;
        const selection=selectionForCapability(settings,"btw");
        selectedModel=selectionLabel(selection);
        // These backends enforce no model tools for restricted / explain requests.
        if(backend!=="claude"&&backend!=="pi") throw new Error(
          "Remember Me requires a tool-free drafting backend (Claude or in-process Pi). "+
          "Select one for BTW through /bro config; "+backend+" does not guarantee this boundary.");
        const prompt=buildRememberPrompt({
          statement:input, context:contextEnabled?capturedContext:undefined,
          history:transcript, memories:store.entries, proposal, preferences
        });
        const pending:RememberTurn={user:input,bro:"Drafting…"};
        transcript.push(pending); show();
        const result=await executeBackend({
          feature:"explain",access:"restricted",cwd:ctx.cwd,prompt
        },selection,attempt.signal);
        if(closed||attempt.signal.aborted)return;
        if(result.status!=="success")throw new Error(result.message);
        const parsed=parseRememberResult(result.text);
        if(parsed.kind==="question") {
          relatedQuestionIds=parsed.relatedIds;
          pending.bro=parsed.message;
          // Keep any existing proposal while asking about corrections.
        } else {
          proposal=makeReviewedProposal(parsed,store.revision,store.entries);
          relatedQuestionIds=[];
          // Retain exact substantive model proposal as part of the conversation history.
          pending.bro=JSON.stringify(parsed);
        }
        browserText="";
        show();
        modal.setNotice(parsed.kind==="question"
          ? "Answer the question; your prior proposal remains available."
          : "Review the full proposal at the bottom. /save approves, or reply to refine.", "info");
      } catch(e) {
        if(!closed&&!attempt.signal.aborted) {
          if(transcript.at(-1)?.user===input&&transcript.at(-1)?.bro==="Drafting…") transcript.pop();
          modal.setNotice(errorMessage(e), "error");
          if(!modal.getComposerText().trim())modal.setComposerText(input);
          show();
        }
      } finally {
        if(controller===attempt)controller=undefined;
        busy=false; if(!closed)modal.setRunning(false);
      }
    };
    function submit(raw:string):void {
      const value=raw.trim();
      if(!value||closed||busy)return;
      modal.clearComposer();
      if(confirmingDelete) {
        const id=confirmingDelete; confirmingDelete=undefined;
        if(value.toLowerCase()!=="yes"){modal.setNotice("Deletion cancelled.");return;}
        busy=true;modal.setRunning(true);
        void changeMemory({kind:"delete",id},store.revision).then(next=>{
          store=next; browserText=renderUserMemory(store);show();modal.setNotice("Deleted "+id,"success");
        }).catch(e=>modal.setNotice(errorMessage(e),"error")).finally(()=>{
          busy=false;if(!closed)modal.setRunning(false);
        });
        return;
      }
      if(value==="/save"){void save();return;}
      if(value==="/confirm-revision"){void save(true);return;}
      if(value==="/help"){show(HELP);return;}
      if(value==="/context show"){
        show(capturedContext ? "## Captured Pi context (not transmitted by inspection)\n\n"+capturedContext : "No Pi context captured.");
        return;
      }
      if(value==="/context off"||value==="/context on"){
        contextEnabled=value.endsWith("on");show();modal.setNotice("Recent Pi context "+(contextEnabled?"included":"omitted")+" on future requests.");return;
      }
      if(value==="/new"){
        proposal=undefined;transcript=[];relatedQuestionIds=[];browserText="";show();
        modal.setNotice("Discarded unfinished draft. Saved memories are unchanged.");return;
      }
      if(value==="/list"||value.startsWith("/list ")){
        const token=value.slice(5).trim();
        const pageNumber=token?Number(token):1;
        if(!Number.isSafeInteger(pageNumber)||pageNumber<1){modal.setNotice("Use /list or /list <page number>.", "warning");return;}
        void refresh((pageNumber-1)*20).catch(e=>modal.setNotice(errorMessage(e),"error"));return;
      }
      if(value.startsWith("/search ")){
        void refresh(0,value.slice(8).trim()).catch(e=>modal.setNotice(errorMessage(e),"error"));return;
      }
      if(value.startsWith("/expand ")){
        const id=value.slice(8).trim();
        show(renderUserMemory(store,{expand:[id]}));return;
      }
      if(value.startsWith("/edit ")){
        if(proposal){modal.setNotice("Finish or /new the current proposal before starting a different edit.","warning");return;}
        const id=value.slice(6).trim();
        const target=store.entries.find(m=>m.id===id);
        if(!target){modal.setNotice("Unknown memory ID. Use /list.","warning");return;}
        proposal={
          action:"update",targetId:id,reviewedRevision:store.revision,reviewedTarget:target,
          draft:{title:target.title,summary:target.summary,background:target.background,
            scope:target.scope,exceptions:target.exceptions,sourceContext:target.sourceContext,
            uncertainty:target.uncertainty,basis:target.basis},relatedIds:[id]
        };
        transcript=[];browserText="";show("Editing "+target.title+". Correct it in plain words, or /save the exact existing text.");return;
      }
      if(value.startsWith("/delete ")){
        const id=value.slice(8).trim();
        if(!store.entries.some(m=>m.id===id)){modal.setNotice("Unknown ID. Use /list.","warning");return;}
        confirmingDelete=id;
        modal.setNotice("Delete "+id+"? Type yes; any other answer cancels.","warning");return;
      }
      if(value.startsWith("/")){modal.setNotice("Unknown command. /help shows the available controls.","warning");return;}
      void ask(value);
    }
    // Disclosure happens before any prompt. An initial command thought only pre-fills the composer.
    modal.setModel(selectedModel);modal.setCustomMode("private draft · explicit save");
    browserText=renderUserMemory(store);
    show();
    if(initial.trim()){
      modal.setComposerText(initial.trim());
      modal.setNotice("Review the backend and /context controls above, then press Enter to start.", "info");
    }
    return modal;
  },{mouse:true});
}
