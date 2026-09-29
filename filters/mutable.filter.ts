import { Filter, FilterResult } from './pool-filters';
import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { getPdaMetadataKey } from '@raydium-io/raydium-sdk';
import { MetadataAccountData, MetadataAccountDataArgs } from '@metaplex-foundation/mpl-token-metadata';
import { Serializer } from '@metaplex-foundation/umi/serializers';
import { logger } from '../helpers';

export class MutableFilter implements Filter {
  private readonly errorMessage: string[] = [];

  constructor(
    private readonly connection: Connection,
    private readonly metadataSerializer: Serializer<MetadataAccountDataArgs, MetadataAccountData>,
    private readonly checkMutable: boolean,
    private readonly checkSocials: boolean,
  ) {
    if (this.checkMutable) {
      this.errorMessage.push('mutable');
    }

    if (this.checkSocials) {
      this.errorMessage.push('socials');
    }
  }

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const metadataPDA = getPdaMetadataKey(poolKeys.baseMint);
      const metadataAccount = await this.connection.getAccountInfo(metadataPDA.publicKey, this.connection.commitment);

      if (!metadataAccount?.data) {
        return { ok: false, message: 'Mutable -> Failed to fetch account data' };
      }

      const deserialize = this.metadataSerializer.deserialize(metadataAccount.data);
      const isMutable = deserialize[0].isMutable;
      const mutableOk = !this.checkMutable || !isMutable;
      const socialsOk = !this.checkSocials || (await this.hasSocials(deserialize[0]));
      const ok = mutableOk && socialsOk;
      const message: string[] = [];

      if (!mutableOk) {
        message.push('metadata can be changed');
      }

      if (!socialsOk) {
        message.push('has no socials');
      }

      return { ok: ok, message: ok ? undefined : `MutableSocials -> Token ${message.join(' and ')}` };
    } catch (e) {
      logger.error({ mint: poolKeys.baseMint }, `MutableSocials -> Failed to check ${this.errorMessage.join(' and ')}`);
    }

    return {
      ok: false,
      message: `MutableSocials -> Failed to check ${this.errorMessage.join(' and ')}`,
    };
  }

  private async hasSocials(metadata: MetadataAccountData) {
    const uri = (metadata.uri || '').trim();
    if (!uri.startsWith('https://') && !uri.startsWith('http://')) {
      return false;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await fetch(uri, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok) {
        return false;
      }
      const data = (await response.json()) as { extensions?: Record<string, unknown> };
      return Object.values(data?.extensions ?? {}).some(
        (value) => value !== null && value !== undefined && String(value).length > 0,
      );
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
