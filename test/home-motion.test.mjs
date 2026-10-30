import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {startHomeMotion} from '../public/home-motion.js';

function fixture(t) {
  const dom=new JSDOM('<main class="page-home"><section class="hero"></section><section class="stats"><span data-stat-count="24" data-stat-key="notes">24</span></section><div class="home-course-description"><p>Full course introduction</p><button hidden>Expand</button></div></main>');
  const {window}=dom, {document}=window, frames=new Map(), listeners=new Set(), observations=[];
  let id=0,hidden=false,reduced=false;
  Object.defineProperty(document,'hidden',{get:()=>hidden});
  window.requestAnimationFrame=fn=>{frames.set(++id,fn);return id;};
  window.cancelAnimationFrame=id=>frames.delete(id);
  window.matchMedia=()=>({get matches(){return reduced;},addEventListener:(name,fn)=>listeners.add(fn),removeEventListener:(name,fn)=>listeners.delete(fn)});
  window.IntersectionObserver=class {
    constructor(fn){this.fn=fn;this.disconnected=false;observations.push(this);}
    observe(){} disconnect(){this.disconnected=true;}
  };
  const root=document.querySelector('main'),hero=root.querySelector('.hero'),stats=root.querySelector('.stats');
  hero.getBoundingClientRect=()=>({left:0,top:0,width:1000,height:400});
  const seen=new Map(),stop=startHomeMotion({document,window,seen,enter:true});
  t.after(()=>{stop();dom.window.close();});
  return {root,hero,stats,document,window,frames,seen,listeners,observations,stop,
    frame(time){const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn(time));},
    visibility(value){hidden=value;document.dispatchEvent(new window.Event('visibilitychange'));},
    reduce(value){reduced=value;for(const fn of listeners)fn();},
    intersect(heroVisible,statsVisible){observations[0].fn([{target:hero,isIntersecting:heroVisible},{target:stats,isIntersecting:statsVisible}]);}
  };
}

test('home counts finish at real values and motion stops for hidden, offscreen and reduced-motion states',t=>{
  const f=fixture(t),value=f.document.querySelector('[data-stat-count]');
  assert.equal(f.frames.size,0,'offscreen statistics do not start work');
  f.intersect(true,true);f.frame(0);assert.equal(value.textContent,'0');
  f.frame(325);assert.equal(value.textContent,'21');
  f.visibility(true);assert.equal(value.textContent,'24');assert.equal(f.frames.size,0);
  assert.equal(f.hero.classList.contains('is-motion-paused'),true);
  f.visibility(false);assert.equal(f.frames.size,0,'completed values do not replay after refocus');
  f.intersect(false,true);assert.equal(f.hero.classList.contains('is-motion-paused'),true);
  f.intersect(true,true);assert.equal(f.hero.classList.contains('is-motion-paused'),false);
  f.reduce(true);assert.equal(f.root.classList.contains('is-motion-reduced'),true);assert.equal(value.textContent,'24');
  f.stop();assert.equal(f.frames.size,0);assert.equal(f.listeners.size,0);assert.equal(f.observations[0].disconnected,true);
  f.intersect(true,true);assert.equal(f.frames.size,0,'a queued observer callback cannot restart effects after navigation');
});

test('home parallax is bounded and reset; long introductions keep their full text available',t=>{
  const f=fixture(t),move=new f.window.Event('pointermove');
  Object.assign(move,{clientX:3000,clientY:-500,pointerType:'mouse'});
  f.hero.dispatchEvent(move);f.frame(0);
  assert.equal(f.hero.style.getPropertyValue('--pointer-x'),'7.00px');
  assert.equal(f.hero.style.getPropertyValue('--pointer-y'),'-6.00px');
  f.hero.dispatchEvent(new f.window.Event('pointerleave'));assert.equal(f.hero.style.getPropertyValue('--pointer-x'),'0px');
  f.reduce(true);f.hero.dispatchEvent(move);assert.equal(f.frames.size,0);
  const description=f.document.querySelector('.home-course-description'),text=description.querySelector('p'),button=description.querySelector('button');
  Object.defineProperty(text,'scrollHeight',{value:200,configurable:true});
  Object.defineProperty(text,'clientHeight',{value:70,configurable:true});
  f.window.dispatchEvent(new f.window.Event('resize'));assert.equal(button.hidden,false);
  assert.equal(text.textContent,'Full course introduction');
  Object.defineProperty(text,'clientHeight',{value:200,configurable:true});description.classList.add('is-expanded');
  f.window.dispatchEvent(new f.window.Event('resize'));assert.equal(button.hidden,false,'expanded text can still be collapsed');
  description.classList.remove('is-expanded');f.window.dispatchEvent(new f.window.Event('resize'));assert.equal(button.hidden,true);
});
