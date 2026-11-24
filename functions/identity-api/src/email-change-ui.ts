import { randomToken } from "@deployments-ai/identity";
import { cookie, type RestApiResponse } from "./http-responses.ts";
import { htmlResponse, scriptJson } from "./identity-ui.ts";

const COPY = {
  confirm: {
    action: "Confirm new email",
    body: "Confirm that this address should become the email for your account. Every session ends, and you sign in again with the new address.",
    done: "Your email address changed. Sign in again with it.",
    path: "/v1/auth/email-change/confirm",
    title: "Confirm your new email",
  },
  report: {
    action: "I did not make this change",
    body: "If you did not change your email, report it here. Every session on the account ends, the password stops working, and your previous address comes back if nobody else has taken it. Then reset your password.",
    done: "Thanks. Every session on the account has ended and its password no longer works. Reset the password to sign in again.",
    path: "/v1/auth/email-change/report",
    title: "Report an email change",
  },
} as const;

/**
 * The page an email-change link opens. The token rides in the fragment so it never reaches logs or
 * a Referer, and nothing happens until the reader presses the button, so mail scanners that open
 * links cannot apply or report a change.
 */
export function emailChangeUi(input: {
  readonly applicationOrigin: string;
  readonly csrf: string;
  readonly csrfCookieName: string;
  readonly kind: keyof typeof COPY;
  readonly secure: boolean;
}): RestApiResponse {
  const nonce = randomToken();
  const copy = COPY[input.kind];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy.title}</title><style nonce="${nonce}">body{font:16px/1.5 system-ui,sans-serif;background:#f7f5f1;color:#181715;margin:0}main{max-width:30rem;margin:10vh auto;padding:2rem;background:#fff;border:1px solid #ddd;border-radius:12px}button,a.button{font:inherit;display:inline-block;padding:.75rem 1rem;border:0;border-radius:7px;background:#181715;color:#fff;cursor:pointer;text-decoration:none}button:focus,a:focus{outline:3px solid #135ea8;outline-offset:2px}[hidden]{display:none}.message{min-height:1.5rem}</style></head><body><main><h1>${copy.title}</h1>
<section id="panel"><p>${copy.body}</p><button type="button" id="act">${copy.action}</button></section>
<p class="message" role="status"></p><p><a class="button" id="continue" hidden href="${input.applicationOrigin}/">Continue</a></p></main>
<script nonce="${nonce}">const csrf=${scriptJson(input.csrf)};const path=${scriptJson(copy.path)};const done=${scriptJson(copy.done)};const message=document.querySelector('.message');const panel=document.querySelector('#panel');const button=document.querySelector('#act');const token=location.hash.startsWith('#token=')?decodeURIComponent(location.hash.slice(7)):'';history.replaceState(null,'',location.pathname);
if(!token){panel.hidden=true;message.textContent='This link is invalid or has expired.'}
button.addEventListener('click',async()=>{button.disabled=true;message.textContent='Working…';const response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({token})});const result=await response.json().catch(()=>({}));panel.hidden=true;message.textContent=response.ok?(result.emailRestored===false?done+' Your previous address is used by another account, so contact support.':done):(result.error_description||'This link is invalid or has expired.');document.querySelector('#continue').hidden=!response.ok});
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
