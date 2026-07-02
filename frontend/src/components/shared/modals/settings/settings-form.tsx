import { useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import React from "react";
import { I18nKey } from "#/i18n/declaration";
import { DangerModal } from "../confirmation-modals/danger-modal";
import { extractSettings } from "#/utils/settings-utils";
import { ModalBackdrop } from "../modal-backdrop";
import { ModelSelector } from "./model-selector";
import { Settings } from "#/types/settings";
import { BrandButton } from "#/components/features/settings/brand-button";
import { SettingsInput } from "#/components/features/settings/settings-input";
import { HelpLink } from "#/ui/help-link";
import { useSaveSettings } from "#/hooks/mutation/use-save-settings";
import { useCreateSecret } from "#/hooks/mutation/use-create-secret";
import { useConfig } from "#/hooks/query/use-config";
import { getAgentSettingValue } from "#/utils/sdk-settings-schema";
import { SETTINGS_FORM } from "#/utils/constants";
import { displayErrorToast } from "#/utils/custom-toast-handlers";
import { cn } from "#/utils/utils";

interface SettingsFormProps {
  settings: Settings;
  onClose: () => void;
}

// Env var each CLI agent reads its credential from. For Claude Code we use
// the OAuth token variable (Claude subscription login) rather than the
// registry's ANTHROPIC_API_KEY, since OAuth is the common local setup.
const ACP_CREDENTIAL_ENV_VARS: Record<string, string> = {
  "claude-code": "CLAUDE_CODE_OAUTH_TOKEN",
  codex: "OPENAI_API_KEY",
  "gemini-cli": "GEMINI_API_KEY",
};

export function SettingsForm({ settings, onClose }: SettingsFormProps) {
  const { mutate: saveUserSettings } = useSaveSettings();
  const { mutateAsync: createSecret } = useCreateSecret();
  const { data: config } = useConfig();

  const location = useLocation();
  const { t } = useTranslation();

  const formRef = React.useRef<HTMLFormElement>(null);

  const [confirmEndSessionModalOpen, setConfirmEndSessionModalOpen] =
    React.useState(false);

  const isAcpEnabled = !!config?.feature_flags?.enable_acp;
  const acpProviders = React.useMemo(
    () =>
      (config?.acp_providers ?? []).filter(
        (provider) => provider.key in ACP_CREDENTIAL_ENV_VARS,
      ),
    [config?.acp_providers],
  );

  const [engineTab, setEngineTab] = React.useState<"llm" | "acp">("llm");
  const [acpProviderKey, setAcpProviderKey] = React.useState("claude-code");
  const [acpToken, setAcpToken] = React.useState("");
  const [isSavingAcp, setIsSavingAcp] = React.useState(false);

  const acpSecretName = ACP_CREDENTIAL_ENV_VARS[acpProviderKey];
  const selectedAcpProvider = acpProviders.find(
    (provider) => provider.key === acpProviderKey,
  );

  const handleAcpSave = async () => {
    setIsSavingAcp(true);
    try {
      if (acpToken.trim()) {
        // Stored as a custom secret; secrets are injected into the CLI
        // subprocess environment by name at conversation start.
        await createSecret({
          name: acpSecretName,
          value: acpToken.trim(),
          description: `${selectedAcpProvider?.display_name ?? acpProviderKey} credential`,
        });
      }
      saveUserSettings(
        {
          agent_settings_diff: {
            agent_kind: "acp",
            acp_server: acpProviderKey,
          },
        },
        {
          onSuccess: () => onClose(),
          onSettled: () => setIsSavingAcp(false),
        },
      );
    } catch (error) {
      setIsSavingAcp(false);
      displayErrorToast(
        error instanceof Error ? error.message : "Failed to save credential",
      );
    }
  };

  const handleFormSubmission = async (formData: FormData) => {
    const newSettings = extractSettings(formData);

    await saveUserSettings(newSettings, {
      onSuccess: () => {
        onClose();
      },
    });
  };

  const handleConfirmEndSession = () => {
    const formData = new FormData(formRef.current ?? undefined);
    handleFormSubmission(formData);
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    if (location.pathname.startsWith("/conversations/")) {
      setConfirmEndSessionModalOpen(true);
    } else {
      handleFormSubmission(formData);
    }
  };

  const isLLMKeySet = settings.llm_api_key_set;
  const currentModel = getAgentSettingValue(settings, "llm.model");

  return (
    <div className="flex flex-col gap-4">
      {isAcpEnabled && acpProviders.length > 0 && (
        <div
          data-testid="engine-tab-toggle"
          className="flex rounded-lg border border-tertiary overflow-hidden"
        >
          <button
            type="button"
            data-testid="engine-tab-llm"
            className={cn(
              "flex-1 py-2 text-sm",
              engineTab === "llm" ? "bg-tertiary font-semibold" : "opacity-60",
            )}
            onClick={() => setEngineTab("llm")}
          >
            {t(I18nKey.AI_SETTINGS$LLM_API_KEY_TAB)}
          </button>
          <button
            type="button"
            data-testid="engine-tab-acp"
            className={cn(
              "flex-1 py-2 text-sm",
              engineTab === "acp" ? "bg-tertiary font-semibold" : "opacity-60",
            )}
            onClick={() => setEngineTab("acp")}
          >
            {t(I18nKey.AI_SETTINGS$CLI_AGENT_TAB)}
          </button>
        </div>
      )}

      {engineTab === "acp" && (
        <div data-testid="acp-setup-form" className="flex flex-col gap-[17px]">
          <p className="text-sm text-gray-300">
            {t(I18nKey.AI_SETTINGS$CLI_AGENT_DESCRIPTION)}
          </p>

          <label className="flex flex-col gap-2.5">
            <span className={SETTINGS_FORM.LABEL_CLASSNAME}>
              {t(I18nKey.AI_SETTINGS$CLI_AGENT_LABEL)}
            </span>
            <select
              data-testid="acp-provider-select"
              className="bg-tertiary border border-[#717888] rounded-sm p-2 w-full"
              value={acpProviderKey}
              onChange={(e) => setAcpProviderKey(e.target.value)}
            >
              {acpProviders.map((provider) => (
                <option key={provider.key} value={provider.key}>
                  {provider.display_name}
                </option>
              ))}
            </select>
          </label>

          <SettingsInput
            testId="acp-token-input"
            name="acp-token-input"
            label={`Credential (stored as secret ${acpSecretName})`}
            type="password"
            className="w-full"
            placeholder={
              acpProviderKey === "claude-code"
                ? "claude setup-token output, or leave empty if already configured"
                : "API key, or leave empty if already configured"
            }
            labelClassName={SETTINGS_FORM.LABEL_CLASSNAME}
            onChange={(value) => setAcpToken(value)}
          />

          {acpProviderKey === "claude-code" && (
            <HelpLink
              testId="acp-token-help-anchor"
              text="Get a long-lived OAuth token by running"
              linkText="claude setup-token"
              href="https://docs.anthropic.com/en/docs/claude-code"
              size="settings"
              linkColor="white"
            />
          )}

          <BrandButton
            testId="save-acp-settings-button"
            type="button"
            variant="primary"
            className="w-full font-semibold"
            isDisabled={isSavingAcp}
            onClick={handleAcpSave}
          >
            {t(I18nKey.BUTTON$SAVE)}
          </BrandButton>
        </div>
      )}

      <form
        ref={formRef}
        data-testid="settings-form"
        className={cn("flex flex-col gap-6", engineTab === "acp" && "hidden")}
        onSubmit={handleSubmit}
      >
        <div className="flex flex-col gap-[17px]">
          <ModelSelector
            currentModel={
              typeof currentModel === "string" ? currentModel : undefined
            }
            wrapperClassName="!flex-col !gap-[17px]"
            labelClassName={SETTINGS_FORM.LABEL_CLASSNAME}
          />

          <SettingsInput
            testId="llm-api-key-input"
            name="llm-api-key-input"
            label={t(I18nKey.SETTINGS_FORM$API_KEY)}
            type="password"
            className="w-full"
            placeholder={isLLMKeySet ? "<hidden>" : ""}
            labelClassName={SETTINGS_FORM.LABEL_CLASSNAME}
          />

          <HelpLink
            testId="llm-api-key-help-anchor"
            text={t(I18nKey.SETTINGS$DONT_KNOW_API_KEY)}
            linkText={t(I18nKey.SETTINGS$CLICK_FOR_INSTRUCTIONS)}
            href="https://docs.openhands.dev/usage/local-setup#getting-an-api-key"
            size="settings"
            linkColor="white"
          />
        </div>

        <div className="flex flex-col gap-2">
          <BrandButton
            testId="save-settings-button"
            type="submit"
            variant="primary"
            className="w-full font-semibold"
          >
            {t(I18nKey.BUTTON$SAVE)}
          </BrandButton>
        </div>
      </form>

      {confirmEndSessionModalOpen && (
        <ModalBackdrop>
          <DangerModal
            title={t(I18nKey.MODAL$END_SESSION_TITLE)}
            description={t(I18nKey.MODAL$END_SESSION_MESSAGE)}
            buttons={{
              danger: {
                text: t(I18nKey.BUTTON$END_SESSION),
                onClick: handleConfirmEndSession,
              },
              cancel: {
                text: t(I18nKey.BUTTON$CANCEL),
                onClick: () => setConfirmEndSessionModalOpen(false),
              },
            }}
          />
        </ModalBackdrop>
      )}
    </div>
  );
}
