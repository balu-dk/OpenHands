import { useMutation, useQueryClient } from "@tanstack/react-query";
import V1ConversationService from "#/api/conversation-service/v1-conversation-service.api";
import { Provider } from "#/types/settings";

interface CheckoutRepositoryVariables {
  conversationId: string;
  repository: string;
  gitProvider?: Provider;
  branch?: string;
}

/**
 * Check a repository out into a running conversation's workspace.
 * The repo is cloned side by side with existing checkouts, so switching
 * projects never destroys existing work in the workspace.
 */
export const useCheckoutRepository = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ["checkout-repository"],
    mutationFn: (variables: CheckoutRepositoryVariables) =>
      V1ConversationService.checkoutRepository(
        variables.conversationId,
        variables.repository,
        variables.gitProvider,
        variables.branch,
      ),
    onSuccess: async (_data, variables) => {
      // The conversation's selected_repository/branch metadata changed.
      await queryClient.invalidateQueries({
        queryKey: ["user", "conversation", variables.conversationId],
      });
    },
  });
};
