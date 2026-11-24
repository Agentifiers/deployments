import { randomToken } from "@deployments-ai/identity";
import { cookie, type RestApiResponse } from "./http-responses.ts";
import { htmlResponse, ISSUER_LABEL_SCRIPT, scriptJson } from "./identity-ui.ts";

/**
 * Where an IdP-initiated sign-in lands. The token rides in the fragment so it never reaches logs
 * or a Referer, and the names it shows are set as text because the IdP and its users choose them.
 */
export function federationConfirmSignInUi(input: {
  readonly csrf: string;
  readonly csrfCookieName: string;
  readonly secure: boolean;
}): RestApiResponse {
  const nonce = randomToken();
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirm sign-in</title><style nonce="${nonce}">body{font:16px/1.5 system-ui,sans-serif;background:#f7f5f1;color:#181715;margin:0}main{max-width:30rem;margin:10vh auto;padding:2rem;background:#fff;border:1px solid #ddd;border-radius:12px}button,.secondary{font:inherit;padding:.75rem 1rem;border:0;border-radius:7px;background:#181715;color:#fff;cursor:pointer}.secondary{display:inline-block;background:#fff;color:#181715;border:2px solid #181715;text-decoration:none}button:focus,a:focus{outline:3px solid #135ea8;outline-offset:2px}[hidden]{display:none}.message{min-height:1.5rem}</style></head><body><main><h1>Confirm sign-in</h1>
<section id="confirm" hidden><p>Sign in to <strong id="confirm-organization"></strong> through <strong id="confirm-provider"></strong> as <strong id="confirm-email"></strong>?</p><p>Continue only if you just chose this app in your identity provider.</p><button type="button" id="confirm-continue">Continue</button> <a class="secondary" id="confirm-cancel" href="/sign-in">Cancel</a></section>
<p class="message" role="status"></p></main>
<script nonce="${nonce}">const csrf=${scriptJson(input.csrf)};const message=document.querySelector('.message');const panel=document.querySelector('#confirm');const continueButton=document.querySelector('#confirm-continue');const token=location.hash.startsWith('#token=')?decodeURIComponent(location.hash.slice(7)):'';history.replaceState(null,'',location.pathname);const invalid='This sign-in link is invalid or has expired.';
${ISSUER_LABEL_SCRIPT}async function post(path){const response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({token})});return{ok:response.ok,result:await response.json()}}
function proceed(result){if(result.kind==='signed-in'){message.textContent='Signing you in…';location.assign(result.location);return}if(result.kind==='mailbox-confirmation-sent'){panel.hidden=true;message.textContent='We sent a confirmation link to '+result.maskedEmail+'. Open it in this browser to connect your account, then sign in again.';return}document.querySelector('#confirm-organization').textContent=result.organizationName;document.querySelector('#confirm-provider').textContent=result.providerDisplayName+' ('+issuerLabel(result.issuer)+')';document.querySelector('#confirm-email').textContent=result.email;message.textContent='';panel.hidden=false}
async function resume(){const {ok,result}=await post('/v1/auth/federation/unsolicited/resume');if(!ok){message.textContent=result.error_description||invalid;return}proceed(result)}
continueButton.addEventListener('click',async()=>{continueButton.disabled=true;message.textContent='Signing you in…';const {ok,result}=await post('/v1/auth/federation/unsolicited/confirm');if(!ok){panel.hidden=true;message.textContent=result.error_description||'Sign-in could not be completed.';return}proceed(result)});
if(token)resume();else message.textContent=invalid;
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
