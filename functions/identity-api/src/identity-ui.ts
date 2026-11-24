import type { FederationDiscovery } from "@deployments-ai/db";
import { randomToken, type HumanVerificationWidget } from "@deployments-ai/identity";
import { cookie, securityHeaders, type RestApiResponse } from "./http-responses.ts";

export function scriptJson(value: unknown) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/** An http(s) issuer reads best as its host; a SAML entity ID such as a URN is shown whole. */
export const ISSUER_LABEL_SCRIPT =
  "function issuerLabel(issuer){try{const url=new URL(issuer);return url.protocol==='https:'||url.protocol==='http:'?url.host:issuer}catch{return issuer}}";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function contentSecurityPolicy(nonce: string, widget: HumanVerificationWidget | undefined) {
  const nonceSource = `'nonce-${nonce}'`;
  const scriptOrigin = widget ? [new URL(widget.scriptUrl).origin] : [];
  const widgetOrigins = widget?.widgetOrigins ?? [];
  return [
    "default-src 'none'",
    ["script-src", nonceSource, ...scriptOrigin, ...widgetOrigins].join(" "),
    ["style-src", nonceSource, ...widgetOrigins].join(" "),
    ["connect-src", "'self'", ...widgetOrigins].join(" "),
    ...(widget ? [["frame-src", ...scriptOrigin, ...widgetOrigins].join(" ")] : []),
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

export function htmlResponse(input: {
  readonly html: string;
  readonly humanVerification?: HumanVerificationWidget;
  readonly nonce: string;
  readonly setCookie?: string;
  readonly statusCode: number;
}): RestApiResponse {
  return {
    body: input.html,
    headers: {
      ...securityHeaders("text/html; charset=utf-8"),
      "Content-Security-Policy": contentSecurityPolicy(input.nonce, input.humanVerification),
    },
    isBase64Encoded: false,
    ...(input.setCookie ? { multiValueHeaders: { "Set-Cookie": [input.setCookie] } } : {}),
    statusCode: input.statusCode,
  };
}

export function authUi(input: {
  readonly applicationOrigin: string;
  readonly csrf: string;
  readonly csrfCookieName: string;
  readonly humanVerification?: HumanVerificationWidget;
  readonly initialMode: "sign-in" | "sign-up";
  readonly organization?: FederationDiscovery;
  readonly registrationEnabled: boolean;
  readonly returnTo?: string;
  readonly secure: boolean;
}): RestApiResponse {
  const nonce = randomToken();
  const widget = input.humanVerification;
  const challenge = widget
    ? `<div class="${escapeHtml(widget.widgetClass)}" data-sitekey="${escapeHtml(widget.siteKey)}"></div>`
    : "";
  const challengeScript = widget
    ? `<script src="${escapeHtml(widget.scriptUrl)}" async defer></script>`
    : "";
  const registrationNavigation = input.registrationEnabled
    ? '<a class="tab" href="#sign-up">Create account</a>'
    : "";
  const registrationForms = input.registrationEnabled
    ? `<form id="sign-up" hidden><h2 class="sr-only">Create account</h2><label>Email<input name="email" type="email" autocomplete="email" required></label>${challenge}<button type="submit">Send verification email</button></form>
<form id="verify" hidden><h2>Verify email</h2><label>Display name<input name="displayName" autocomplete="name"></label><label>New password<input name="password" type="password" minlength="15" autocomplete="new-password" aria-describedby="verify-password-help" required><span class="help" id="verify-password-help">At least 15 characters. A short phrase is easiest to remember.</span></label><button type="submit">Verify and continue</button></form>`
    : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deployments.ai identity</title>${challengeScript}<style nonce="${nonce}">
body{font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f4f4f5;color:#09090b;margin:0;-webkit-font-smoothing:antialiased}main{max-width:24rem;margin:10vh auto;padding:0 1rem}h1{font-size:1.125rem;font-weight:600;margin:0 0 1.5rem;text-align:center}h2{font-size:1rem;font-weight:600;margin:0}p{margin:0;color:#52525b}.card{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:1.5rem;box-shadow:0 1px 2px rgb(0 0 0/.04)}form,.panel{display:grid;gap:1rem}label{display:grid;gap:.375rem;font-weight:500}.help{font-weight:400;font-size:.8125rem;color:#71717a}input{font:inherit;width:100%;box-sizing:border-box;padding:.5rem .75rem;border:1px solid #d4d4d8;border-radius:8px;background:#fff;color:inherit}button{font:inherit;font-weight:500;padding:.5rem .75rem;border:1px solid #18181b;border-radius:8px;background:#18181b;color:#fff;cursor:pointer}button:hover{background:#27272a}button:disabled{opacity:.6;cursor:default}.secondary{background:#fff;color:#18181b;border-color:#d4d4d8}.secondary:hover{background:#f4f4f5}a{color:#09090b;text-decoration:underline;text-decoration-color:#a1a1aa;text-underline-offset:3px}a:hover{text-decoration-color:#09090b}input:focus,button:focus,a:focus{outline:2px solid #3b82f6;outline-offset:2px}nav{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:.25rem;padding:.25rem;margin-bottom:1.25rem;background:#f4f4f5;border-radius:8px}a.tab{padding:.375rem;border-radius:6px;text-align:center;text-decoration:none;color:#52525b;font-weight:500}a.tab[aria-current=page]{background:#fff;color:#09090b;box-shadow:0 1px 2px rgb(0 0 0/.08)}[hidden]{display:none}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.message:empty{display:none}.message{margin-top:1rem;padding:.625rem .75rem;border-radius:8px;background:#f4f4f5;color:#27272a}.message.error{background:#fef2f2;color:#991b1b}
</style></head><body><main><h1>Deployments.ai</h1><div class="card"><nav><a class="tab" href="#sign-in">Sign in</a>${registrationNavigation}</nav>
<form id="sign-in"><h2 class="sr-only">Sign in</h2><label>Email<input name="email" type="email" autocomplete="email" required></label><label id="password-field">Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button><a href="#forgot">Forgot password?</a></form>
<form id="mfa" hidden><h2>Two-factor authentication</h2><p>Enter the code from your authenticator app, or one of your recovery codes.</p><label>Code<input name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" required></label><button type="submit">Verify</button><button type="button" class="secondary" id="mfa-restart">Start over</button></form>
<section class="panel" id="sso" hidden><h2>Single sign-on</h2><button type="button" id="sso-continue">Continue</button><button type="button" class="secondary" id="sso-password" hidden>Use a password instead</button></section>
${registrationForms}
<form id="forgot" hidden><h2>Reset password</h2><label>Email<input name="email" type="email" autocomplete="email" required></label>${challenge}<button type="submit">Send reset email</button></form>
<form id="reset" hidden><h2>Choose a new password</h2><label>New password<input name="password" type="password" minlength="15" autocomplete="new-password" aria-describedby="reset-password-help" required><span class="help" id="reset-password-help">At least 15 characters. A short phrase is easiest to remember.</span></label><button type="submit">Reset password</button></form>
<p class="message" role="status"></p></div></main>
<script nonce="${nonce}">const applicationOrigin=${scriptJson(input.applicationOrigin)};const csrf=${scriptJson(input.csrf)};const initialMode=${scriptJson(input.initialMode)};const registrationEnabled=${scriptJson(input.registrationEnabled)};const returnTo=${scriptJson(input.returnTo ?? "")};const forms=[...document.querySelectorAll('form')];const message=document.querySelector('.message');let actionToken='';let resetToken='';let challengeToken='';
const organization=${scriptJson(input.organization ?? null)};const signIn=document.querySelector('#sign-in');const passwordField=document.querySelector('#password-field');const sso=document.querySelector('#sso');const ssoContinue=document.querySelector('#sso-continue');const ssoPassword=document.querySelector('#sso-password');let ssoTarget=null;let loginHint='';
${ISSUER_LABEL_SCRIPT}function passwordStep(visible){passwordField.hidden=!visible;passwordField.querySelector('input').disabled=!visible;signIn.querySelector('button').textContent=visible?'Sign in':'Continue'}function offerSso(target,passwordOffered){ssoTarget=target;ssoContinue.textContent='Continue with '+target.displayName+' ('+issuerLabel(target.issuer)+')';ssoPassword.hidden=!passwordOffered;sso.hidden=false}
function show(id){forms.forEach(f=>f.hidden=f.id!==id);sso.hidden=!(id==='sign-in'&&ssoTarget);document.querySelectorAll('a.tab').forEach(a=>{if(a.getAttribute('href')==='#'+id)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current')})}function say(text,error){message.textContent=text;message.classList.toggle('error',Boolean(error))}function route(){say('');let hash=location.hash.slice(1);if(hash.startsWith('verify=')){actionToken=registrationEnabled?decodeURIComponent(hash.slice(7)):'';resetToken='';history.replaceState(null,'',location.pathname+(registrationEnabled?'#verify':'#sign-in'));hash=registrationEnabled?'verify':'sign-in'}if(hash.startsWith('reset=')){resetToken=decodeURIComponent(hash.slice(6));actionToken='';history.replaceState(null,'',location.pathname+'#reset');hash='reset'}const authMode=['sign-in','forgot'].includes(hash)||(registrationEnabled&&hash==='sign-up')?hash:'';show(resetToken?'reset':registrationEnabled&&actionToken?'verify':(authMode||hash||initialMode))}if(organization){offerSso(organization,false);passwordStep(true)}else passwordStep(false);addEventListener('hashchange',route);route();
let csrfToken=csrf;function cookieCsrf(){const prefix=${scriptJson(input.csrfCookieName)}+'=';const entry=document.cookie.split('; ').find(c=>c.startsWith(prefix));return entry?entry.slice(prefix.length):''}async function post(path,body){const send=()=>fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-csrf-token':csrfToken},body:JSON.stringify(body)});let response=await send();const current=cookieCsrf();if(response.status===403&&current&&current!==csrfToken){csrfToken=current;response=await send()}return response}
async function discover(email){const response=await post('/v1/auth/federation/discover',{email});const result=await response.json();if(!response.ok){say(result.error_description||'Something went wrong. Reload the page and try again.',true);return}say('');if(result.kind==='sso'){loginHint=email;offerSso(result,true);return}passwordStep(true);passwordField.querySelector('input').focus()}
signIn.querySelector('input[name=email]').addEventListener('input',()=>{if(organization)return;ssoTarget=null;sso.hidden=true;passwordStep(false)});ssoPassword.addEventListener('click',()=>{ssoPassword.hidden=true;passwordStep(true);passwordField.querySelector('input').focus()});
ssoContinue.addEventListener('click',async()=>{say('Working…');const response=await post('/v1/auth/federation/start',{organizationId:ssoTarget.organizationId,returnTo,loginHint});const result=await response.json();if(response.ok){location.assign(result.location);return}say(result.error_description||'Single sign-on could not be started.',true)});
for(const form of forms)form.addEventListener('submit',async e=>{e.preventDefault();say('Working…');const body=Object.fromEntries(new FormData(form));if(form===signIn&&passwordField.hidden){await discover(String(body.email||''));return}if(form.id==='verify')body.token=actionToken;if(form.id==='reset')body.token=resetToken;if(form.id==='mfa')body.challengeToken=challengeToken;const path={"sign-in":"/v1/auth/sign-in",mfa:"/v1/auth/sign-in/mfa","sign-up":"/v1/auth/sign-up",verify:"/v1/auth/verify-email",forgot:"/v1/auth/password/forgot",reset:"/v1/auth/password/reset"}[form.id];const response=await post(path,body);const result=await response.json();if(form===signIn&&response.ok&&result.mfaRequired){challengeToken=result.challengeToken;show('mfa');form.reset();document.querySelector('#mfa input').focus();say('');return}if(form.id==='mfa'&&response.status===401){challengeToken='';show('sign-in')}if(!response.ok){say(result.error_description||'Something went wrong. Reload the page and try again.',true);return}if(['sign-up','forgot'].includes(form.id)){const address=String(body.email||'');say((form.id==='sign-up'?'Check your inbox at ':'If an account uses ')+address+(form.id==='sign-up'?'. We sent a link to verify your email. It can take a minute; check spam if it does not arrive.':', we sent it a link to reset the password. Check your inbox.'));return}challengeToken='';if(['verify','reset'].includes(form.id)){actionToken='';resetToken='';history.replaceState(null,'',location.pathname+'#sign-in');show('sign-in');const email=typeof result.email==='string'?result.email:'';if(email){signIn.querySelector('input[name=email]').value=email;passwordStep(true);passwordField.querySelector('input').focus()}say('Password saved. Sign in with your new password.');return}say('Signing you in…');location.href=returnTo||applicationOrigin});
document.querySelector('#mfa-restart').addEventListener('click',()=>{challengeToken='';say('');show('sign-in')});
</script></body></html>`;
  return htmlResponse({
    html,
    ...(widget ? { humanVerification: widget } : {}),
    nonce,
    setCookie: cookie(input.csrfCookieName, input.csrf, {
      httpOnly: false,
      maxAge: 600,
      secure: input.secure,
    }),
    statusCode: 200,
  });
}

export function authorizationConsentUi(
  requestHandle: string,
  csrf: string,
  csrfCookieName: string,
  secure: boolean,
  clientName: string,
  requestedScopes: readonly string[],
): RestApiResponse {
  const nonce = randomToken();
  const scopeItems = requestedScopes
    .map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`)
    .join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirm CLI access</title><style nonce="${nonce}">body{font:16px/1.5 system-ui,sans-serif;background:#f7f5f1;color:#181715;margin:0}main{max-width:30rem;margin:10vh auto;padding:2rem;background:#fff;border:1px solid #ddd;border-radius:12px}button{font:inherit;padding:.75rem 1rem;border:0;border-radius:7px;background:#181715;color:#fff;cursor:pointer}button:focus{outline:3px solid #135ea8;outline-offset:2px}code{font-size:.9em}li{margin:.35rem 0}.message{min-height:1.5rem}</style></head><body><main><h1>Authorize ${escapeHtml(clientName)}?</h1><p><strong>${escapeHtml(clientName)}</strong> is requesting this access:</p><ul>${scopeItems}</ul><p>Only continue if you started this login from your terminal.</p><button type="button" id="authorize">Authorize CLI</button><p class="message" role="status"></p></main><script nonce="${nonce}">const csrf=${scriptJson(csrf)};const requestHandle=${scriptJson(requestHandle)};const message=document.querySelector('.message');document.querySelector('#authorize').addEventListener('click',async()=>{message.textContent='Working…';const response=await fetch('/v1/oauth/authorize',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({request_handle:requestHandle})});const result=await response.json();if(response.ok){location.assign(result.redirect);return}message.textContent=result.error_description||'Authorization could not be completed.'});</script></body></html>`;
  return htmlResponse({
    html,
    nonce,
    setCookie: cookie(csrfCookieName, csrf, { httpOnly: false, maxAge: 600, secure }),
    statusCode: 200,
  });
}

export function federationMessageUi(input: {
  readonly message: string;
  readonly statusCode: number;
  readonly title: string;
}): RestApiResponse {
  const nonce = randomToken();
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title><style nonce="${nonce}">body{font:16px/1.5 system-ui,sans-serif;background:#f7f5f1;color:#181715;margin:0}main{max-width:30rem;margin:10vh auto;padding:2rem;background:#fff;border:1px solid #ddd;border-radius:12px}a:focus{outline:3px solid #135ea8;outline-offset:2px}</style></head><body><main><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.message)}</p><p><a href="/sign-in">Return to sign-in</a></p></main></body></html>`;
  return htmlResponse({ html, nonce, statusCode: input.statusCode });
}

export function federationLinkUi(input: {
  readonly csrf: string;
  readonly csrfCookieName: string;
  readonly secure: boolean;
}): RestApiResponse {
  const nonce = randomToken();
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect your sign-in</title><style nonce="${nonce}">body{font:16px/1.5 system-ui,sans-serif;background:#f7f5f1;color:#181715;margin:0}main{max-width:30rem;margin:10vh auto;padding:2rem;background:#fff;border:1px solid #ddd;border-radius:12px}button{font:inherit;padding:.75rem 1rem;border:0;border-radius:7px;background:#181715;color:#fff;cursor:pointer}button:focus,a:focus{outline:3px solid #135ea8;outline-offset:2px}[hidden]{display:none}.message{min-height:1.5rem}</style></head><body><main><h1>Connect your sign-in</h1>
<section id="link" hidden><p>Someone signed in through <strong id="link-provider"></strong>, the identity provider for <strong id="link-organization"></strong>, using your email address.</p><p>Connect only if that was you. Once connected, that identity provider account can sign in to your Deployments.ai account.</p><button type="button" id="link-confirm">Connect my account</button></section>
<p class="message" role="status"></p><a id="link-continue" href="/sign-in" hidden>Continue to sign-in</a></main>
<script nonce="${nonce}">const csrf=${scriptJson(input.csrf)};const message=document.querySelector('.message');const panel=document.querySelector('#link');const confirmButton=document.querySelector('#link-confirm');const continueLink=document.querySelector('#link-continue');const token=location.hash.startsWith('#token=')?decodeURIComponent(location.hash.slice(7)):'';history.replaceState(null,'',location.pathname);
async function post(path){const response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({token})});return{ok:response.ok,result:await response.json()}}
${ISSUER_LABEL_SCRIPT}async function describe(){const {ok,result}=await post('/v1/auth/federation/link-request');if(!ok){message.textContent=result.error_description||'This confirmation link is invalid or has expired.';return}document.querySelector('#link-provider').textContent=result.identityProvider.displayName+' ('+issuerLabel(result.identityProvider.issuer)+')';document.querySelector('#link-organization').textContent=result.organizationName;panel.hidden=false}
confirmButton.addEventListener('click',async()=>{confirmButton.disabled=true;message.textContent='Connecting your account…';const {ok,result}=await post('/v1/auth/federation/confirm-link');if(!ok){confirmButton.disabled=false;message.textContent=result.error_description||'Your account could not be connected.';return}panel.hidden=true;message.textContent='Your account is connected. Sign in to continue.';if(result.provider)continueLink.href='/sign-in?organization='+encodeURIComponent(result.provider.organizationId);continueLink.hidden=false});
if(token)describe();else message.textContent='This confirmation link is invalid or has expired.';
</script></body></html>`;
  return htmlResponse({
    html,
    nonce,
    setCookie: cookie(input.csrfCookieName, input.csrf, {
      httpOnly: false,
      maxAge: 600,
      secure: input.secure,
    }),
    statusCode: 200,
  });
}
