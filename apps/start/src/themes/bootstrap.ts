import { DEFAULT_THEME, THEME_IDS } from "./registry";

/** localStorage key of the chosen theme. The mode keeps its own key in `lib/theme.ts`. */
export const THEME_NAME_KEY = "mfw:v2:theme-name";

/**
 * The inline <head> script: sets `data-theme`, `data-mode`, `data-density` and
 * `.dark` before the body paints. Each storage read is guarded on its own, so
 * blocked storage still leaves a correct theme and dark class.
 * Precedence: `?theme=` / `?mode=`, then storage, then the default and the OS.
 */
export function themeBootstrapScript(): string {
	return `(function(){
var r=document.documentElement,ids=${JSON.stringify(THEME_IDS)};
function g(k){try{return localStorage.getItem(k)}catch(e){return null}}
var q;try{q=new URLSearchParams(location.search)}catch(e){q=null}
var n=q&&q.get("theme");
if(ids.indexOf(n)<0)n=g(${JSON.stringify(THEME_NAME_KEY)});
if(ids.indexOf(n)<0)n=${JSON.stringify(DEFAULT_THEME)};
r.setAttribute("data-theme",n);
var t=q&&q.get("mode");
if(t!=="light"&&t!=="dark")t=g("mfw:v2:theme");
if(t==="light"||t==="dark")r.setAttribute("data-mode",t);
if(g("mfw:v2:density")==="compact")r.setAttribute("data-density","compact");
var os=false;try{os=matchMedia("(prefers-color-scheme: dark)").matches}catch(e){}
r.classList.toggle("dark",t==="dark"||(t!=="light"&&os));
})()`;
}
