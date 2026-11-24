import {
  authorizationCodeRecord,
  authorizationRequestRecord,
  isDatabaseWriteConflict,
  makeIdentitySecurityEventRecord,
  type IdentityRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import {
  IdentityError,
  randomToken,
  sha256,
  systemRandom,
  validateAuthorizationRequest,
} from "@deployments-ai/identity";
import {
  domainClient,
  put,
  type AuthenticatedBrowserSession,
  type ClientRecord,
  type OAuthApplicationConfig,
  type OAuthApplicationDependencies,
} from "./oauth-application-support.ts";
import { plusSeconds } from "./time-arithmetic.ts";

export interface AuthorizationInteractionInput {
  readonly browserSession: AuthenticatedBrowserSession;
  readonly clientId: string;
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: string;
  readonly nonce?: string;
  readonly redirectUri: string;
  readonly reauthenticationToken?: string;
  readonly requestFingerprint?: string;
  readonly responseType: string;
  readonly scopes: readonly string[];
  readonly state?: string;
}

interface AuthorizationApplicationInput {
  readonly client: (clientId: string) => Promise<ClientRecord>;
  readonly config: OAuthApplicationConfig;
  readonly dependencies: OAuthApplicationDependencies;
  readonly reauthenticationForSession: (input: {
    readonly browserSession: AuthenticatedBrowserSession;
    readonly requestFingerprint: string;
    readonly token: string;
  }) => Promise<IdentityRecord<"oauth-reauthentication-request">>;
}

export function makeOAuthAuthorizationApplication(input: AuthorizationApplicationInput) {
  const { client, config, dependencies, reauthenticationForSession } = input;
  const now = dependencies.now ?? (() => new Date());
  const random = dependencies.random ?? systemRandom;

  function assertAuthorizationCodeGrant(record: ClientRecord) {
    if (!record.data.grantTypes.includes("authorization_code")) {
      throw new IdentityError(
        "unauthorized_client",
        "Client is not authorized for the authorization_code grant.",
        { exposeDescription: true },
      );
    }
  }

  async function activePrincipalSession(browserSession: AuthenticatedBrowserSession) {
    const [principal, security, locator] = await Promise.all([
      dependencies.repository.principalForId(browserSession.principalId),
      dependencies.repository.securityStateForPrincipal(browserSession.principalId),
      dependencies.repository.sessionLocator(browserSession.principalId, browserSession.sessionId),
    ]);
    const timestamp = now().getTime();
    if (
      principal?.data.status !== "active" ||
      !security ||
      !locator ||
      locator.data.status !== "active" ||
      locator.data.principalId !== browserSession.principalId ||
      locator.data.sessionId !== browserSession.sessionId ||
      Date.parse(locator.data.expiresAt) <= timestamp
    ) {
      throw new IdentityError("access_denied", "Authentication session is no longer active.");
    }
    const session = await dependencies.repository.sessionForHash(locator.data.sessionTokenHash);
    if (
      session?.data.status !== "active" ||
      session.data.id !== browserSession.sessionId ||
      session.data.principalId !== browserSession.principalId ||
      session.data.sessionEpoch !== security.data.sessionEpoch ||
      Date.parse(session.data.expiresAt) <= timestamp ||
      Date.parse(session.data.idleExpiresAt) <= timestamp
    ) {
      throw new IdentityError("access_denied", "Authentication session is no longer active.");
    }
    return { locator, principal, security, session };
  }

  async function beginAuthorizationInteraction(request: AuthorizationInteractionInput) {
    const clientRecord = await client(request.clientId);
    assertAuthorizationCodeGrant(clientRecord);
    const scopes = validateAuthorizationRequest({
      client: domainClient(clientRecord),
      ...(request.codeChallenge ? { codeChallenge: request.codeChallenge } : {}),
      ...(request.codeChallengeMethod ? { codeChallengeMethod: request.codeChallengeMethod } : {}),
      ...(request.nonce ? { nonce: request.nonce } : {}),
      redirectUri: request.redirectUri,
      responseType: request.responseType,
      scopes: request.scopes,
    });
    const reauthentication = request.reauthenticationToken
      ? await reauthenticationForSession({
          browserSession: request.browserSession,
          requestFingerprint: request.requestFingerprint ?? "",
          token: request.reauthenticationToken,
        })
      : undefined;
    if (!request.reauthenticationToken && request.requestFingerprint) {
      throw new IdentityError("invalid_request", "Reauthentication binding is incomplete.");
    }
    const activeSession = await activePrincipalSession(request.browserSession);

    const timestamp = now();
    const createdAt = timestamp.toISOString();
    const requestHandle = randomToken(random);
    const pending = authorizationRequestRecord({
      clientId: request.clientId,
      codeChallenge: request.codeChallenge!,
      createdAt,
      expiresAt: plusSeconds(timestamp, config.authorizationRequestSeconds),
      id: dependencies.generateId(),
      ...(request.nonce ? { nonce: request.nonce } : {}),
      ...(reauthentication ? { reauthenticationTokenHash: reauthentication.data.tokenHash } : {}),
      redirectUri: request.redirectUri,
      requestHandleHash: sha256(requestHandle),
      requestedScopes: scopes,
      ...(request.state ? { state: request.state } : {}),
    });
    const authenticated = {
      ...pending,
      data: {
        ...pending.data,
        authenticationSessionId: request.browserSession.sessionId,
        principalId: request.browserSession.principalId,
        status: "authenticated" as const,
      },
    };
    await dependencies.repository.transact([
      ...dependencies.repository.loginMaterialVersionChecks(
        activeSession.principal,
        activeSession.security,
      ),
      ...dependencies.repository.browserSessionVersionChecks(
        activeSession.locator,
        activeSession.session,
      ),
      put(authenticated),
    ]);
    return requestHandle;
  }

  async function confirmAuthorizationInteraction(confirmation: {
    readonly browserSession: AuthenticatedBrowserSession;
    readonly clientId: string;
    readonly requestHandle: string;
  }) {
    const requestHandleHash = sha256(confirmation.requestHandle);
    const request = await dependencies.repository.authorizationRequestForHash(requestHandleHash);
    const timestamp = now();
    if (
      !request ||
      request.data.status !== "authenticated" ||
      request.data.clientId !== confirmation.clientId ||
      request.data.principalId !== confirmation.browserSession.principalId ||
      request.data.authenticationSessionId !== confirmation.browserSession.sessionId ||
      Date.parse(request.data.expiresAt) <= timestamp.getTime()
    ) {
      throw new IdentityError("access_denied", "Authorization interaction is no longer active.");
    }
    const clientRecord = await client(request.data.clientId);
    assertAuthorizationCodeGrant(clientRecord);
    const currentScopes = validateAuthorizationRequest({
      client: domainClient(clientRecord),
      codeChallenge: request.data.codeChallenge,
      codeChallengeMethod: request.data.codeChallengeMethod,
      ...(request.data.nonce ? { nonce: request.data.nonce } : {}),
      redirectUri: request.data.redirectUri,
      responseType: request.data.responseType,
      scopes: request.data.requestedScopes,
    });
    if (currentScopes.join(" ") !== request.data.requestedScopes.join(" ")) {
      throw new IdentityError("access_denied", "OAuth client registration changed.");
    }
    const { principal, security, locator, session } = await activePrincipalSession(
      confirmation.browserSession,
    );
    const reauthentication = request.data.reauthenticationTokenHash
      ? await dependencies.repository.reauthenticationRequestForHash(
          request.data.reauthenticationTokenHash,
        )
      : undefined;
    if (
      request.data.reauthenticationTokenHash &&
      (!reauthentication ||
        reauthentication.data.status !== "pending" ||
        Date.parse(reauthentication.data.expiresAt) <= timestamp.getTime() ||
        Date.parse(confirmation.browserSession.authenticationTime) <
          Date.parse(reauthentication.data.createdAt) ||
        reauthentication.data.previousSessionId === confirmation.browserSession.sessionId)
    ) {
      throw new IdentityError("login_required", "Fresh authentication is required.");
    }

    const createdAt = timestamp.toISOString();
    const rawCode = randomToken(random);
    const codeHash = sha256(rawCode);
    const codeId = dependencies.generateId();
    const code = authorizationCodeRecord({
      authenticationTime: confirmation.browserSession.authenticationTime,
      authorizationRequestId: request.data.id,
      browserSessionId: confirmation.browserSession.sessionId,
      clientId: request.data.clientId,
      codeChallenge: request.data.codeChallenge,
      codeHash,
      createdAt,
      expiresAt: plusSeconds(timestamp, config.authorizationCodeSeconds),
      id: codeId,
      ...(request.data.nonce ? { nonce: request.data.nonce } : {}),
      principalId: confirmation.browserSession.principalId,
      redirectUri: request.data.redirectUri,
      scopes: request.data.requestedScopes,
      sessionEpoch: security.data.sessionEpoch,
    });
    const completed = {
      ...request,
      data: {
        ...request.data,
        authorizationCodeHash: codeHash,
        completedAt: createdAt,
        status: "completed" as const,
        updatedAt: createdAt,
        version: request.data.version + 1,
      },
    };
    const event = makeIdentitySecurityEventRecord({
      aggregateId: codeId,
      aggregateType: "oauth-authorization-code",
      aggregateVersion: 1,
      eventId: dependencies.generateId(),
      eventType: "identity.authorization-code-issued",
      occurredAt: createdAt,
      principalId: confirmation.browserSession.principalId,
      payload: { clientId: request.data.clientId },
    });
    const consumedReauthentication = reauthentication
      ? {
          ...reauthentication,
          data: {
            ...reauthentication.data,
            authenticatedSessionId: confirmation.browserSession.sessionId,
            consumedAt: createdAt,
            status: "consumed" as const,
            updatedAt: createdAt,
            version: reauthentication.data.version + 1,
          },
        }
      : undefined;
    const operations: TransactionOperation[] = [
      ...dependencies.repository.loginMaterialVersionChecks(principal, security),
      ...dependencies.repository.browserSessionVersionChecks(locator, session),
      { kind: "put", previousRecord: request, record: completed },
    ];
    if (consumedReauthentication && reauthentication) {
      operations.push({
        kind: "put",
        previousRecord: reauthentication,
        record: consumedReauthentication,
      });
    }
    operations.push(put(code), put(event));
    try {
      await dependencies.repository.transact(operations);
    } catch (error) {
      if (!isDatabaseWriteConflict(error)) throw error;
      const current = await dependencies.repository.authorizationRequestForHash(requestHandleHash);
      if (current?.data.status !== "authenticated") {
        throw new IdentityError("access_denied", "Authorization interaction is no longer active.");
      }
      if (reauthentication) {
        const currentReauthentication =
          await dependencies.repository.reauthenticationRequestForHash(
            reauthentication.data.tokenHash,
          );
        if (currentReauthentication?.data.status !== "pending") {
          throw new IdentityError("login_required", "Fresh authentication is required.");
        }
      }
      throw error;
    }

    const redirect = new URL(request.data.redirectUri);
    redirect.searchParams.set("code", rawCode);
    if (request.data.state) redirect.searchParams.set("state", request.data.state);
    redirect.searchParams.set("iss", config.issuer);
    return redirect.toString();
  }

  async function authorize(
    request: AuthorizationInteractionInput & { readonly confirmed: boolean },
  ) {
    if (request.clientId === "deployments-cli" && !request.confirmed) {
      throw new IdentityError("access_denied", "CLI authorization requires explicit confirmation.");
    }
    const requestHandle = await beginAuthorizationInteraction(request);
    return confirmAuthorizationInteraction({
      browserSession: request.browserSession,
      clientId: request.clientId,
      requestHandle,
    });
  }

  return { authorize, beginAuthorizationInteraction, confirmAuthorizationInteraction };
}
