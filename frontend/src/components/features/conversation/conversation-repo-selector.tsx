import React from "react";
import type { AxiosError } from "axios";
import { useActiveConversation } from "#/hooks/query/use-active-conversation";
import { useCheckoutRepository } from "#/hooks/mutation/use-checkout-repository";
import { useConversationId } from "#/hooks/use-conversation-id";
import { useUserProviders } from "#/hooks/use-user-providers";
import { Branch, GitRepository } from "#/types/git";
import { GitRepoDropdown } from "../home/git-repo-dropdown";
import { GitBranchDropdown } from "../home/git-branch-dropdown";
import { BrandButton } from "../settings/brand-button";
import {
  displayErrorToast,
  displaySuccessToast,
} from "#/utils/custom-toast-handlers";
import { retrieveAxiosErrorMessage } from "#/utils/retrieve-axios-error-message";

/**
 * Repository switcher for an active conversation.
 *
 * Lets the user pick another repository (and optionally a branch) and checks
 * it out into the running workspace in the background — no sandbox restart.
 * The repository is cloned side by side with existing checkouts, so previous
 * work is never destroyed.
 */
export function ConversationRepoSelector() {
  const { conversationId } = useConversationId();
  const { data: conversation } = useActiveConversation();
  const { providers } = useUserProviders();
  const { mutate: checkoutRepository, isPending } = useCheckoutRepository();

  const [selectedRepository, setSelectedRepository] =
    React.useState<GitRepository | null>(null);
  const [selectedBranch, setSelectedBranch] = React.useState<Branch | null>(
    null,
  );

  const provider =
    selectedRepository?.git_provider ||
    conversation?.git_provider ||
    providers[0];

  const isSandboxRunning = conversation?.sandbox_status === "RUNNING";

  // Only offer switching to a different repository than the current one.
  const isSwitchable =
    !!selectedRepository &&
    selectedRepository.full_name !== conversation?.selected_repository;

  const handleRepoSelection = (repository?: GitRepository) => {
    setSelectedRepository(repository ?? null);
    setSelectedBranch(null);
  };

  const handleCheckout = () => {
    if (!selectedRepository) return;
    checkoutRepository(
      {
        conversationId,
        repository: selectedRepository.full_name,
        gitProvider: selectedRepository.git_provider,
        branch: selectedBranch?.name,
      },
      {
        onSuccess: (data) => {
          displaySuccessToast(
            `Checked out ${data.repository} at ${data.project_dir}`,
          );
          setSelectedRepository(null);
          setSelectedBranch(null);
        },
        onError: (error) => {
          displayErrorToast(retrieveAxiosErrorMessage(error as AxiosError));
        },
      },
    );
  };

  if (!conversation || conversation.sandbox_status === "MISSING") {
    return null;
  }

  return (
    <div
      data-testid="conversation-repo-selector"
      className="flex items-center gap-2"
    >
      <GitRepoDropdown
        provider={provider}
        value={selectedRepository?.id || null}
        repositoryName={
          selectedRepository?.full_name ||
          conversation.selected_repository ||
          null
        }
        placeholder="Switch repository..."
        disabled={!isSandboxRunning || isPending}
        onChange={handleRepoSelection}
        className="max-w-[260px]"
      />
      {isSwitchable && (
        <>
          <GitBranchDropdown
            repository={selectedRepository?.full_name || null}
            provider={provider}
            selectedBranch={selectedBranch}
            onBranchSelect={setSelectedBranch}
            defaultBranch={selectedRepository?.main_branch || null}
            placeholder="Branch"
            disabled={isPending}
            className="max-w-[180px]"
          />
          <BrandButton
            testId="conversation-repo-checkout-button"
            variant="primary"
            type="button"
            isDisabled={isPending}
            onClick={handleCheckout}
          >
            {isPending ? "Checking out..." : "Checkout"}
          </BrandButton>
        </>
      )}
    </div>
  );
}
