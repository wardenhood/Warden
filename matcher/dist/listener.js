/**
 * Chain listener for Robinhood Chain (EVM / Arbitrum Orbit).
 *
 * Sluice on Casper subscribes to the CSPR.cloud WebSocket feed. RHC is a
 * standard Ethereum JSON-RPC/WebSocket chain, so we use eth_subscribe("logs")
 * against any RHC-compatible provider (Quicknode, Chainstack, Blockdaemon,
 * Alchemy, or a self-hosted Arbitrum Nitro node).
 *
 * We watch a configurable list of {address, abi, eventName} targets (e.g. an
 * ERC-20 tokenized-equity contract's Transfer event, a treasury contract's
 * custom events, etc), decode each log, and flatten it into the plain object
 * the predicate engine evaluates against.
 */
import { ethers } from "ethers";
import { EventEmitter } from "node:events";
export class ChainListener extends EventEmitter {
    wsUrl;
    targets;
    provider;
    contracts = [];
    constructor(wsUrl, targets) {
        super();
        this.wsUrl = wsUrl;
        this.targets = targets;
        this.provider = new ethers.WebSocketProvider(wsUrl);
    }
    async start() {
        for (const target of this.targets) {
            const contract = new ethers.Contract(target.address, target.abi, this.provider);
            contract.on(target.eventName, (...args) => {
                const eventLog = args[args.length - 1];
                this.handleLog(target, eventLog, args.slice(0, -1));
            });
            this.contracts.push(contract);
        }
        const ws = this.provider.websocket;
        ws.on?.("close", () => {
            this.emit("disconnected");
            this.reconnect();
        });
        this.emit("connected");
    }
    handleLog(target, log, decodedArgs) {
        const flat = {
            address: target.address.toLowerCase(),
            eventName: target.eventName,
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
            logIndex: log.index,
        };
        // Map named args from the fragment onto the flat object (from, to, value, ...)
        const fragment = log.fragment;
        fragment.inputs.forEach((input, i) => {
            const value = decodedArgs[i];
            flat[input.name] = typeof value === "bigint" ? value.toString() : value;
        });
        this.emit("event", flat);
    }
    async reconnect(attempt = 1) {
        const delay = Math.min(1000 * 2 ** attempt, 30_000);
        await new Promise((r) => setTimeout(r, delay));
        try {
            // Clean old contract listeners before reconnecting
            for (const c of this.contracts)
                await c.removeAllListeners();
            this.contracts = [];
            this.provider = new ethers.WebSocketProvider(this.wsUrl);
            await this.start();
        }
        catch {
            this.reconnect(attempt + 1);
        }
    }
    async stop() {
        for (const c of this.contracts)
            await c.removeAllListeners();
        await this.provider.destroy();
    }
}
/** Minimal ERC-20 ABI fragment — enough for Transfer-based recipes (tokenized equities, ETFs). */
export const ERC20_TRANSFER_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
];
