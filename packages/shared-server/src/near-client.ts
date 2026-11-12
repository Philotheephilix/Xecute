import { connect, type Near, type Account } from 'near-api-js';
import type { KeyStore } from 'near-api-js/lib/key_stores/index.js';

export interface NearClientConfig {
  networkId: 'sandbox' | 'testnet' | 'mainnet';
  nodeUrl: string;
  keyStore?: KeyStore | undefined;
}

export interface ViewFunctionArgs {
  contractId: string;
  methodName: string;
  args?: Record<string, unknown> | undefined;
}

export interface CallFunctionArgs {
  accountId: string;
  contractId: string;
  methodName: string;
  args?: Record<string, unknown> | undefined;
  gas?: bigint | undefined;
  attachedDeposit?: bigint | undefined;
}

export interface NearClient {
  viewFunction(args: ViewFunctionArgs): Promise<unknown>;
  callFunction(args: CallFunctionArgs): Promise<unknown>;
  getAccount(accountId: string): Promise<Account>;
  near: Near;
}

export async function createNearClient(config: NearClientConfig): Promise<NearClient> {
  const connectConfig = config.keyStore !== undefined
    ? { networkId: config.networkId, nodeUrl: config.nodeUrl, keyStore: config.keyStore }
    : { networkId: config.networkId, nodeUrl: config.nodeUrl };

  const near = await connect(connectConfig);

  const viewFunction = async (args: ViewFunctionArgs): Promise<unknown> => {
    const account = await near.account('');
    return account.viewFunction({
      contractId: args.contractId,
      methodName: args.methodName,
      args: args.args ?? {},
    });
  };

  const callFunction = async (args: CallFunctionArgs): Promise<unknown> => {
    const account = await near.account(args.accountId);
    return account.functionCall({
      contractId: args.contractId,
      methodName: args.methodName,
      args: args.args ?? {},
      gas: args.gas ?? BigInt(30_000_000_000_000),
      attachedDeposit: args.attachedDeposit ?? BigInt(0),
    });
  };

  const getAccount = async (accountId: string): Promise<Account> => {
    return near.account(accountId);
  };

  return {
    viewFunction,
    callFunction,
    getAccount,
    near,
  };
}
