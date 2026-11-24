import {
  makeAdministrationContext,
  type FederationAdministrationDependencies,
} from "./administration-context.ts";
import {
  makeLoginDomainAdministration,
  type LoginDomainAdministration,
} from "./administration-domains.ts";
import {
  makeFederatedLinkAdministration,
  type FederatedLinkAdministration,
} from "./administration-links.ts";
import {
  makeIdentityProviderAdministration,
  type IdentityProviderAdministration,
} from "./administration-provider.ts";

export interface IdentityFederationAdministration
  extends LoginDomainAdministration, IdentityProviderAdministration, FederatedLinkAdministration {}

export function makeIdentityFederationAdministration(
  dependencies: FederationAdministrationDependencies,
): IdentityFederationAdministration {
  const context = makeAdministrationContext(dependencies);
  return {
    ...makeLoginDomainAdministration(context),
    ...makeIdentityProviderAdministration(context),
    ...makeFederatedLinkAdministration(context),
  };
}
