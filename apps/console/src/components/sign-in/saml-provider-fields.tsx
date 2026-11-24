import { oneOf } from "../../observability/range.ts";
import {
  METADATA_SOURCES,
  type MetadataSource,
  type ProviderForm,
  type SamlProvider,
} from "../../sign-in/identity-provider.ts";
import {
  Description,
  Field,
  Fieldset,
  Label,
  Legend,
  RadioField,
  SwitchField,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { CopyField } from "../copy-field.tsx";

const METADATA_SOURCE_COPY: {
  readonly [Source in MetadataSource]: { readonly description: string; readonly label: string };
} = {
  document: {
    description: "Paste the metadata file the identity provider exports.",
    label: "Metadata XML",
  },
  url: {
    description: "The platform fetches it each time you save.",
    label: "Metadata URL",
  },
};

export function ServiceProviderValues({
  serviceProvider,
}: Readonly<{ serviceProvider: SamlProvider["serviceProvider"] }>) {
  return (
    <>
      <CopyField label="Entity ID" value={serviceProvider.entityId} />
      <CopyField label="ACS URL" value={serviceProvider.acsUrl} />
      <CopyField label="Metadata URL" value={serviceProvider.metadataUrl} />
    </>
  );
}

export function SamlProviderFields({
  form,
  serviceProvider,
  update,
}: Readonly<{
  form: ProviderForm;
  serviceProvider: SamlProvider["serviceProvider"] | undefined;
  update: (patch: Partial<ProviderForm>) => void;
}>) {
  return (
    <>
      <Fieldset>
        <Legend>Service provider</Legend>
        <Text>
          Create a SAML application in the identity provider with these values. Okta calls the ACS
          URL the single sign-on URL and the entity ID the audience URI. Microsoft Entra ID calls
          them the reply URL and the identifier.
        </Text>
        {serviceProvider ? (
          <ServiceProviderValues serviceProvider={serviceProvider} />
        ) : (
          <Text>Loading the service provider values…</Text>
        )}
      </Fieldset>
      <Fieldset>
        <Legend>Identity provider metadata</Legend>
        <RadioGroup
          className="mt-3"
          onValueChange={(value: string) => {
            const metadataSource = oneOf(METADATA_SOURCES, value);
            if (metadataSource) update({ metadataSource });
          }}
          value={form.metadataSource}
        >
          {METADATA_SOURCES.map((source) => (
            <RadioField key={source}>
              <RadioGroupItem value={source} />
              <Label>{METADATA_SOURCE_COPY[source].label}</Label>
              <Description>{METADATA_SOURCE_COPY[source].description}</Description>
            </RadioField>
          ))}
        </RadioGroup>
        {form.metadataSource === "url" ? (
          <Field className="mt-4">
            <Label>Metadata URL</Label>
            <Input
              autoComplete="off"
              className="font-mono"
              onChange={(event) => update({ metadataUrl: event.target.value })}
              value={form.metadataUrl}
            />
          </Field>
        ) : (
          <Field className="mt-4">
            <Label>Metadata XML</Label>
            <Textarea
              className="font-mono"
              onChange={(event) => update({ metadataDocument: event.target.value })}
              rows={6}
              value={form.metadataDocument}
            />
          </Field>
        )}
      </Fieldset>
      <Field>
        <Label>Email attribute</Label>
        <Description>
          Optional. Leave blank when the NameID is the email address; otherwise name the attribute
          that carries it.
        </Description>
        <Input
          autoComplete="off"
          className="font-mono"
          onChange={(event) => update({ emailAttribute: event.target.value })}
          value={form.emailAttribute}
        />
      </Field>
      <SwitchField>
        <Label>IdP-initiated sign-in</Label>
        <Description>
          Members can start from the identity provider&apos;s app list, then confirm on a platform
          page before they are signed in.
        </Description>
        <Switch
          checked={form.unsolicitedSignIn}
          name="unsolicitedSignIn"
          onCheckedChange={(unsolicitedSignIn) => update({ unsolicitedSignIn })}
        />
      </SwitchField>
    </>
  );
}
