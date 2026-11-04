const $=id=>document.getElementById(id);
const form=$("agentForm"),goal=$("goal"),run=$("run"),status=$("status"),work=$("work"),steps=$("steps"),reply=$("reply"),taskList=$("taskList");
document.querySelectorAll("[data-example]").forEach(b=>b.addEventListener("click",()=>{goal.value=b.dataset.example;goal.focus()}));
function addStep(label,detail){const el=document.createElement("div");el.className="step";const b=document.createElement("b");b.textContent=label;const s=document.createElement("span");s.textContent=detail;el.append(b,s);steps.append(el)}
form.addEventListener("submit",async e=>{e.preventDefault();const message=goal.value.trim();if(!message)return;run.disabled=true;run.textContent="جاري تنفيذ المهمة...";status.textContent="تعمل الآن";work.hidden=false;steps.replaceChildren();reply.textContent="";addStep("1","فهم الهدف وتجهيز الأدوات");try{const r=await fetch("/api/agent",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({message})});const data=await r.json();if(!r.ok)throw new Error(data.error||"تعذر تنفيذ المهمة");(data.steps||[]).forEach((s,i)=>addStep(String(i+2),s));reply.textContent=data.reply||"انتهى التنفيذ.";status.textContent="اكتملت";if((data.steps||[]).some(s=>s.includes("حفظ")))loadTasks()}catch(err){reply.textContent=err.message;status.textContent="تعذر التنفيذ"}finally{run.disabled=false;run.textContent="ابدئي تنفيذ المهمة"}});
async function loadTasks(){taskList.textContent="جاري التحميل...";try{const r=await fetch("/api/agent/tasks",{credentials:"same-origin"});const d=await r.json();if(!r.ok)throw new Error(d.error||"تعذر تحميل المهام");taskList.replaceChildren();if(!d.tasks?.length){taskList.textContent="لا توجد مهام محفوظة حتى الآن.";return}d.tasks.forEach(t=>{
 const label=document.createElement("label");label.className="task"+(t.done?" done":"");
 const input=document.createElement("input");input.type="checkbox";input.checked=!!t.done;
 input.addEventListener("change",()=>toggleTask(t.id,input.checked));
 const content=document.createElement("span");content.className="task-content";
 const title=document.createElement("b");title.textContent=t.title;content.append(title);
 const meta=document.createElement("small");
 const priority=t.priority==="high"?"أولوية عالية":t.priority==="low"?"أولوية منخفضة":"أولوية عادية";
 const due=t.due_at?" • الموعد: "+new Date(Number(t.due_at)*1000).toLocaleString("ar-EG"):"";
 meta.textContent=priority+due;content.append(meta);
 if(t.details){const details=document.createElement("small");details.textContent=t.details;content.append(details);}
 label.append(input,content);taskList.append(label);
})}catch(e){taskList.textContent=e.message}}
async function toggleTask(id,done){try{const r=await fetch("/api/agent/tasks",{method:"PATCH",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({id,done})});if(!r.ok)throw new Error();loadTasks()}catch{loadTasks()}}
$("refresh").addEventListener("click",loadTasks);