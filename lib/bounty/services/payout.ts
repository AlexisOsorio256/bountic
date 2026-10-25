import "server-only";

import { getLocusServerClient } from "@/lib/clients/locus/server";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { getSupabaseServerEnv } from "@/lib/env/server";
import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";
import { parseWalletSplits, splitAmount } from "@/lib/bounty/services/wallet-split";

const BOUNTIC_ADDRESS_REGEX = /<!--\s*bountic-address:\s*(0x[a-fA-F0-9]{40})\s*-->/i;

export type PayoutResult = {
  transactionId: string;
  txHash: string | null;
  payoutType: "wallet" | "email" | "unclaimed";
  recipientEmail?: string | null;
  recipientWallet?: string | null;
};

function extractWalletFromPrBody(prBody: string | null): string | null {
  if (!prBody) return null;
  const match = BOUNTIC_ADDRESS_REGEX.exec(prBody);
  return match ? match[1] : null;
}

async function getRecipientEmail(githubUsername: string): Promise<string | null> {
  const supabase = getSupabaseServiceClient();
  const { data: user } = await supabase
    .from("users")
    .select("email")
    .eq("github_username", githubUsername)
    .maybeSingle();
  return user?.email ?? null;
}

async function commentOnIssue(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}) {
  const installationId = await getGithubRepoInstallationId(params.owner, params.repo);
  const github = await getGithubInstallationClient(installationId);

  await github.rest.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.issueNumber,
    body: params.body,
  });
}

export async function callLocusPayoutByEmail(params: {
  toEmail: string;
  amount: number;
  memo: string;
}): Promise<PayoutResult> {
  const locus = getLocusServerClient();

  try {
    const payload = await locus.request<{
      transaction_id: string;
      tx_hash?: string;
    }>("/pay/send-email", {
      method: "POST",
      body: {
        email: params.toEmail,
        amount: params.amount,
        memo: params.memo,
        expires_in_days: 30
      },
    });

    return {
      transactionId: payload.transaction_id,
      txHash: payload.tx_hash ?? null,
      payoutType: "email",
      recipientEmail: params.toEmail,
    };
  } catch (error) {
    console.error("Locus email payout failed:", error);
    throw error;
  }
}

export async function callLocusPayoutByWallet(params: {
  toAddress: string;
  amount: number;
  memo: string;
}): Promise<PayoutResult> {
  const locus = getLocusServerClient();

  const payload = await locus.request<{
    transaction_id: string;
    tx_hash?: string;
  }>("/pay/send", {
    method: "POST",
    body: {
      to_address: params.toAddress,
      amount: params.amount.toFixed(2),
      memo: params.memo,
    },
  });

  return {
    transactionId: payload.transaction_id,
    txHash: payload.tx_hash ?? null,
    payoutType: "wallet",
    recipientWallet: params.toAddress,
  };
}

export async function handleUnclaimedPayout(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  winningPrAuthor: string;
  amount: number;
  issueId: string;
}): Promise<PayoutResult> {
  const env = getSupabaseServerEnv();

  await commentOnIssue({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.issueNumber,
    body: `🎉 Congratulations @${params.winningPrAuthor}! You've won this bounty ($${params.amount.toFixed(2)} USDC).

To claim your payout, please connect your [GitHub account](${env.NEXT_PUBLIC_APP_URL}/connect)

Once connected, a maintainer can approve your payout and the funds will be sent to your registered email.`,
  });

  return {
    transactionId: `unclaimed_${Date.now()}`,
    txHash: null,
    payoutType: "unclaimed",
    recipientEmail: null,
  };
}

export async function resolveAndPayout(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  winningPrAuthor: string;
  winningPrBody: string | null;
  amount: number;
  issueId: string;
}): Promise<PayoutResult> {
  const walletFromPr = extractWalletFromPrBody(params.winningPrBody);
  const recipientEmail = await getRecipientEmail(params.winningPrAuthor);

  if (walletFromPr) {
    return callLocusPayoutByWallet({
      toAddress: walletFromPr,
      amount: params.amount,
      memo: `Bountic payout for ${params.issueId}`,
    });
  }

  if (recipientEmail) {
    return callLocusPayoutByEmail({
      toEmail: recipientEmail,
      amount: params.amount,
      memo: `Bountic payout for ${params.issueId}`,
    });
  }

  return handleUnclaimedPayout({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.issueNumber,
    winningPrAuthor: params.winningPrAuthor,
    amount: params.amount,
    issueId: params.issueId,
  });
}
export type SplitPayoutResult = {
  results: PayoutResult[];
  shares: { address: string; amount: number }[];
};

/**
 * Pay every wallet declared in a `bountic-splits` tag on the winning PR.
 *
 * Falls back to `resolveAndPayout` (single recipient) when the PR does not
 * declare a split, so existing bounties keep their behaviour.
 */
export async function resolveAndPayoutSplit(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  winningPrAuthor: string;
  winningPrBody: string | null;
  amount: number;
  issueId: string;
}): Promise<SplitPayoutResult> {
  const shares = parseWalletSplits(params.winningPrBody);

  if (!shares) {
    const single = await resolveAndPayout(params);
    return { results: [single], shares: [{ address: single.recipientWallet ?? "", amount: params.amount }] };
  }

  const amounts = splitAmount(params.amount, shares);
  const results: PayoutResult[] = [];

  for (const slice of amounts) {
    results.push(
      await callLocusPayoutByWallet({
        toAddress: slice.address,
        amount: slice.amount,
        memo: `Bountic split payout for ${params.issueId}`,
      }),
    );
  }

  return { results, shares: amounts };
}
