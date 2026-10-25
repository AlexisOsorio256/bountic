import "server-only";

import { resolveAndPayoutSplit } from "@/lib/bounty/services/payout";
import { syncGithubBountyArtifacts } from "@/lib/bounty/services/github-sync";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";
import { buildIssueId } from "@/lib/bounty/issue-id";

export async function approveBountyPayout(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  approvedBy: string;
}) {
  const issueId = buildIssueId(params.owner, params.repo, params.issueNumber);
  const supabase = getSupabaseServiceClient();

  const { data: bounty, error: bountyError } = await supabase
    .from("bounties")
    .select("issue_id, status, total_amount, winning_pr_author, winning_pr_number")
    .eq("issue_id", issueId)
    .maybeSingle();

  if (bountyError) {
    throw new Error(`Failed to load bounty: ${bountyError.message}`);
  }

  if (!bounty) {
    throw new Error("Bounty not found");
  }

  if (bounty.status === "PAID") {
    throw new Error("Bounty has already been paid");
  }

  if (bounty.status !== "LOCKED") {
    throw new Error("Bounty must be LOCKED before payout approval");
  }

  if (!bounty.winning_pr_author) {
    throw new Error("No winning PR author found for payout");
  }

  let winningPrBody: string | null = null;
  if (bounty.winning_pr_number) {
    try {
      const installationId = await getGithubRepoInstallationId(params.owner, params.repo);
      const github = await getGithubInstallationClient(installationId);
      const prResponse = await github.rest.pulls.get({
        owner: params.owner,
        repo: params.repo,
        pull_number: bounty.winning_pr_number,
      });
      winningPrBody = prResponse.data.body ?? null;
    } catch (err) {
      console.warn("Failed to fetch PR body for wallet extraction:", err);
    }
  }

  // one payout per wallet declared in the winning PR (split tag), else a single payout
  const splitResult = await resolveAndPayoutSplit({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.issueNumber,
    winningPrAuthor: bounty.winning_pr_author,
    winningPrBody,
    amount: bounty.total_amount,
    issueId,
  });

  const payoutResult = splitResult.results[0];
  const isSplit = splitResult.results.length > 1;
  const txHashes = splitResult.results
    .map((result) => result.txHash)
    .filter((hash): hash is string => Boolean(hash));

  const now = new Date().toISOString();

  const { error: updateError } = await supabase
    .from("bounties")
    .update({
      status: "PAID",
      payout_tx_hash: isSplit ? txHashes.join(",") : payoutResult.txHash,
      paid_at: now,
      approved_by: params.approvedBy,
    })
    .eq("issue_id", issueId);

  if (updateError) {
    throw new Error(`Failed to update bounty status to PAID: ${updateError.message}`);
  }

  const payoutEvents = splitResult.results.map((result, index) => ({
    issue_id: issueId,
    recipient_username: bounty.winning_pr_author,
    amount: splitResult.shares[index]?.amount ?? bounty.total_amount,
    locus_transaction_id: result.transactionId,
    transaction_hash: result.txHash,
    status: "SUCCESS",
    metadata: {
      approved_by: params.approvedBy,
      payout_source: "web",
      payout_type: result.payoutType,
      recipient_email: result.recipientEmail,
      recipient_wallet: result.recipientWallet,
      split_index: index,
      split_total: splitResult.results.length,
    },
  }));

  const { error: payoutEventError } = await supabase.from("payout_events").insert(payoutEvents);

  if (payoutEventError) {
    throw new Error(`Failed to persist payout event: ${payoutEventError.message}`);
  }

  const { error: activityError } = await supabase.from("activity_events").insert({
    issue_id: issueId,
    event_type: "PAYOUT_SENT",
    actor_username: bounty.winning_pr_author,
    amount: bounty.total_amount,
    tx_hash: payoutResult.txHash,
    metadata: {
      approved_by: params.approvedBy,
      payout_source: "web",
      payout_type: payoutResult.payoutType,
    },
  });

  if (activityError) {
    throw new Error(`Failed to persist payout activity: ${activityError.message}`);
  }

  await syncGithubBountyArtifacts(issueId);

  return {
    issueId,
    amount: bounty.total_amount,
    recipient: bounty.winning_pr_author,
    payoutType: payoutResult.payoutType,
    recipientEmail: payoutResult.recipientEmail,
    recipientWallet: payoutResult.recipientWallet,
    txHash: payoutResult.txHash,
    transactionId: payoutResult.transactionId,
    approvedBy: params.approvedBy,
  };
}