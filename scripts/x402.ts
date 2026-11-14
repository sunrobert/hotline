// x402 price feed: set it up, and buy from it the way the agent does.
//
//   npm run x402 -- setup        make the seller key, put it on the allowlist, give it gas
//   npm run x402 -- buy [ASSET]  call get_price on the running server (default ETH)
//
// Arc testnet only. Never prints a private key.

import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET, explorerTx } from "../src/wallet/arc.ts";
import { withFeeFloor } from "../src/wallet/fees.ts";
import { formatUsdc, microsToNative, nativeToMicros } from "../src/money.ts";
import { setEnvValue } from "./tunnel-lib.ts";

const ENV_FILE = new URL("../.env.local", import.meta.url);
const GAS_FLOAT = 500_000; // 0.5 USDC: hundreds of settlements' worth of gas on Arc
const rpcUrl = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.io";
const reader = createPublicClient({ chain: ARC_TESTNET, transport: http(rpcUrl, { retryCount: 3 }) });

async function setup(): Promise<void> {
  let env = readFileSync(ENV_FILE, "utf8");
  let key = process.env.PRICES_PRIVATE_KEY?.trim() as `0x${string}` | undefined;
  if (!key) {
    key = generatePrivateKey();
    env = setEnvValue(env, "PRICES_PRIVATE_KEY", key);
    console.log("key        PRICES_PRIVATE_KEY created in .env.local");
  } else {
    console.log("key        PRICES_PRIVATE_KEY already set");
  }
  const seller = privateKeyToAccount(key).address;

  const allowlist = process.env.ALLOWLIST ?? "";
  if (allowlist.toLowerCase().includes(seller.toLowerCase())) {
    console.log(`allowlist  seller already listed`);
  } else if (/(^|,)\s*prices\s*:/i.test(allowlist)) {
    throw new Error("ALLOWLIST has a different 'prices' entry. Fix it by hand.");
  } else {
    env = setEnvValue(env, "ALLOWLIST", `${allowlist.replace(/,\s*$/, "")},prices:${seller}`);
    console.log("allowlist  added prices -> seller");
  }
  writeFileSync(ENV_FILE, env);

  const balance = nativeToMicros(await reader.getBalance({ address: seller }));
  console.log(`seller     ${seller}  ${formatUsdc(balance)} USDC`);
  if (balance >= GAS_FLOAT / 2) return;

  const senderKey = process.env.SENDER_PRIVATE_KEY as `0x${string}` | undefined;
  if (!senderKey) throw new Error("SENDER_PRIVATE_KEY is needed to give the seller gas money");
  const sender = createWalletClient({ account: privateKeyToAccount(senderKey), chain: ARC_TESTNET, transport: http(rpcUrl, { retryCount: 3 }) });
  const hash = await sender.sendTransaction({ to: seller, value: microsToNative(GAS_FLOAT), ...withFeeFloor(await reader.estimateFeesPerGas()) });
  await reader.waitForTransactionReceipt({ hash, timeout: 60_000 });
  console.log(`gas        sent ${formatUsdc(GAS_FLOAT)} USDC from sender  ${explorerTx(hash)}`);
  console.log("\nRestart the server so it loads the price feed.");
}

async function buy(asset: string): Promise<void> {
  const port = process.env.PORT || "8787";
  const owner = (process.env.OWNER_NUMBERS ?? "").split(",")[0]?.trim();
  const started = Date.now();
  const res = await fetch(`http://localhost:${port}/tools/get_price`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hotline-secret": process.env.HOTLINE_SECRET ?? "" },
    body: JSON.stringify({ asset, caller_id: owner, conversation_id: `x402-cli-${started}` }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  console.log(JSON.stringify(body, null, 2));
  console.log(`\n${Date.now() - started} ms`);
  if (typeof body.tx_hash === "string") console.log(explorerTx(body.tx_hash));
}

const [command = "buy", arg] = process.argv.slice(2);
if (command === "setup") await setup();
else if (command === "buy") await buy(arg ?? "ETH");
else { console.error("usage: npm run x402 -- setup | buy [ASSET]"); process.exit(1); }
