import { $ } from './ui.js';
let period={start:'',end:''};
export function periodURL(path) {return path+'?'+new URLSearchParams(period);}
export function periodControls(el,ctx) {
  const form=document.createElement('form');
  form.className='filters';
  form.innerHTML='<label>С <input class="f" type="date" name="start"></label><label>По <input class="f" type="date" name="end"></label><button class="btn">Применить период</button><button class="btn" type="button">Всё время</button>';
  form.elements.start.value=period.start; form.elements.end.value=period.end;
  form.onsubmit=e=>{e.preventDefault();period={start:form.elements.start.value,end:form.elements.end.value};ctx.rerender();};
  $('button[type=button]',form).onclick=()=>{period={start:'',end:''};ctx.rerender();};
  el.querySelector('.ph')?.after(form);
}
