import { Hash, Utils } from '@bsv/sdk'
const { Reader, Writer } = Utils

// Constants
export const HASH_SIZE = 32;
export const COINBASE_PLACEHOLDER = new Array(32).fill(0); // All zeros for coinbase placeholder

// SubtreeNode represents a node in the subtree
export interface SubtreeNode {
    hash: number[];       // 32-byte transaction hash (called txid in JSON for UI compatibility)
    fee: bigint;          // Fee amount
    sizeInBytes: bigint;  // Size in bytes
}

// TxMap interface for transaction hash mapping
export interface TxMap {
    put(hash: number[], value: bigint): void;
    get(hash: number[]): bigint | undefined;
    exists(hash: number[]): boolean;
    length(): number;
    keys(): number[][];
}

// Simple TxMap implementation using Map with hex string keys
export class SimpleTxMap implements TxMap {
    private map = new Map<string, bigint>();

    private hashToKey(hash: number[]): string {
        return Utils.toHex(hash);
    }

    put(hash: number[], value: bigint): void {
        this.map.set(this.hashToKey(hash), value);
    }

    get(hash: number[]): bigint | undefined {
        return this.map.get(this.hashToKey(hash));
    }

    exists(hash: number[]): boolean {
        return this.map.has(this.hashToKey(hash));
    }

    length(): number {
        return this.map.size;
    }

    keys(): number[][] {
        return Array.from(this.map.keys()).map(key => Utils.toArray(key, 'hex'));
    }
}

// Utility functions
function isPowerOfTwo(n: number): boolean {
    return n > 0 && (n & (n - 1)) === 0;
}

// Using BSV SDK Writer and Reader instead of custom functions

function arraysEqual(a: number[], b: number[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export class Subtree {
    height: number;
    fees: bigint;
    sizeInBytes: bigint;
    feeHash: number[];
    nodes: SubtreeNode[];
    conflictingNodes: number[][];

    // Private fields
    private rootHash: number[] | null = null;
    private treeSize: number = 0;
    private nodeIndex: Map<string, number> | null = null;

    constructor(height: number = 0) {
        this.height = height;
        this.fees = BigInt(0);
        this.sizeInBytes = BigInt(0);
        this.feeHash = new Array(32).fill(0);
        this.nodes = [];
        this.conflictingNodes = [];
        this.treeSize = Math.pow(2, height);
    }

    // Static factory methods
    static newTree(height: number): Subtree {
        if (height < 0) {
            throw new Error('height must be at least 0');
        }
        return new Subtree(height);
    }

    static newTreeByLeafCount(maxNumberOfLeaves: number): Subtree {
        if (!isPowerOfTwo(maxNumberOfLeaves)) {
            throw new Error('numberOfLeaves must be a power of two');
        }
        const height = Math.ceil(Math.log2(maxNumberOfLeaves));
        return new Subtree(height);
    }

    static newIncompleteTreeByLeafCount(maxNumberOfLeaves: number): Subtree {
        const height = Math.ceil(Math.log2(maxNumberOfLeaves));
        return new Subtree(height);
    }

    static fromBytes(bytes: number[]): Subtree {
        const subtree = new Subtree();
        subtree.deserialize(bytes);
        return subtree;
    }

    // Core methods
    duplicate(): Subtree {
        const newSubtree = new Subtree(this.height);
        newSubtree.fees = this.fees;
        newSubtree.sizeInBytes = this.sizeInBytes;
        newSubtree.feeHash = [...this.feeHash];
        newSubtree.nodes = this.nodes.map(node => ({
            hash: [...node.hash],
            fee: node.fee,
            sizeInBytes: node.sizeInBytes
        }));
        newSubtree.conflictingNodes = this.conflictingNodes.map(hash => [...hash]);
        newSubtree.rootHash = this.rootHash ? [...this.rootHash] : null;
        newSubtree.treeSize = this.treeSize;
        return newSubtree;
    }

    size(): number {
        return this.treeSize;
    }

    length(): number {
        return this.nodes.length;
    }

    isComplete(): boolean {
        return this.nodes.length === this.treeSize;
    }

    addNode(hash: number[], fee: bigint, sizeInBytes: bigint): void {
        if (this.nodes.length + 1 > this.treeSize) {
            throw new Error('subtree is full');
        }

        if (arraysEqual(hash, COINBASE_PLACEHOLDER)) {
            throw new Error('[AddNode] coinbase placeholder node should be added with AddCoinbaseNode');
        }

        const node: SubtreeNode = {
            hash: [...hash],
            fee,
            sizeInBytes
        };

        this.nodes.push(node);
        this.rootHash = null; // reset rootHash
        this.fees += fee;
        this.sizeInBytes += sizeInBytes;

        if (this.nodeIndex) {
            this.nodeIndex.set(Utils.toHex(hash), this.nodes.length - 1);
        }
    }

    addSubtreeNode(node: SubtreeNode): void {
        if (this.nodes.length + 1 > this.treeSize) {
            throw new Error('subtree is full');
        }

        if (arraysEqual(node.hash, COINBASE_PLACEHOLDER)) {
            throw new Error('[AddSubtreeNode] coinbase placeholder node should be added with AddCoinbaseNode');
        }

        this.nodes.push({
            hash: [...node.hash],
            fee: node.fee,
            sizeInBytes: node.sizeInBytes
        });
        this.rootHash = null;
        this.fees += node.fee;
        this.sizeInBytes += node.sizeInBytes;

        if (this.nodeIndex) {
            this.nodeIndex.set(Utils.toHex(node.hash), this.nodes.length - 1);
        }
    }

    addCoinbaseNode(): void {
        if (this.nodes.length !== 0) {
            throw new Error('subtree should be empty before adding a coinbase node');
        }

        this.nodes.push({
            hash: COINBASE_PLACEHOLDER,
            fee: BigInt(0),
            sizeInBytes: BigInt(0)
        });
        this.rootHash = null;
        this.fees = BigInt(0);
        this.sizeInBytes = BigInt(0);
    }

    addConflictingNode(newConflictingNode: number[]): void {
        // Check if the conflicting node is actually in the subtree
        let found = false;
        for (const node of this.nodes) {
            if (arraysEqual(node.hash, newConflictingNode)) {
                found = true;
                break;
            }
        }

        if (!found) {
            throw new Error('conflicting node is not in the subtree');
        }

        // Check if already added
        for (const conflictingNode of this.conflictingNodes) {
            if (arraysEqual(conflictingNode, newConflictingNode)) {
                return; // Already exists
            }
        }

        this.conflictingNodes.push([...newConflictingNode]);
    }

    removeNodeAtIndex(index: number): void {
        if (index >= this.nodes.length) {
            throw new Error('index out of range');
        }

        const node = this.nodes[index];
        this.fees -= node.fee;
        this.sizeInBytes -= node.sizeInBytes;

        const hashKey = Utils.toHex(Array.from(node.hash));
        this.nodes.splice(index, 1);
        this.rootHash = null;

        if (this.nodeIndex) {
            this.nodeIndex.delete(hashKey);
        }
    }

    nodeIndexLookup(hash: number[]): number {
        if (!this.nodeIndex) {
            // Create the node index map
            this.nodeIndex = new Map();
            for (let i = 0; i < this.nodes.length; i++) {
                const key = Utils.toHex(this.nodes[i].hash);
                this.nodeIndex.set(key, i);
            }
        }

        const key = Utils.toHex(hash);
        return this.nodeIndex.get(key) ?? -1;
    }

    hasNode(hash: number[]): boolean {
        return this.nodeIndexLookup(hash) !== -1;
    }

    getNode(hash: number[]): SubtreeNode | null {
        const index = this.nodeIndexLookup(hash);
        if (index !== -1) {
            return this.nodes[index];
        }
        return null;
    }

    // Serialization methods
    serialize(): number[] {
        const writer = new Writer();

        // Write root hash
        const rootHash = this.getRootHash();
        if (rootHash) {
            writer.write(rootHash);
        } else {
            writer.write(new Array(32).fill(0));
        }

        // Write fees
        writer.writeUInt64LE(Number(this.fees));

        // Write size
        writer.writeUInt64LE(Number(this.sizeInBytes));

        // Write number of nodes
        writer.writeUInt64LE(this.nodes.length);

        // Write nodes
        for (const node of this.nodes) {
            writer.write(node.hash);
            writer.writeUInt64LE(Number(node.fee));
            writer.writeUInt64LE(Number(node.sizeInBytes));
        }

        // Write number of conflicting nodes
        writer.writeUInt64LE(this.conflictingNodes.length);

        // Write conflicting nodes
        for (const conflictingNode of this.conflictingNodes) {
            writer.write(conflictingNode);
        }

        return writer.toArray();
    }

    serializeNodes(): Uint8Array {
        const buffer = new Uint8Array(this.nodes.length * 32);
        let offset = 0;

        for (const node of this.nodes) {
            buffer.set(node.hash, offset);
            offset += 32;
        }

        return buffer;
    }

    deserialize(bytes: number[]): void {
        const reader = new Reader(bytes);

        // Read root hash
        this.rootHash = reader.read(32);

        // Read fees
        this.fees = BigInt(reader.readUInt64LEBn().toString());

        // Read sizeInBytes
        this.sizeInBytes = BigInt(reader.readUInt64LEBn().toString());

        // Read number of nodes
        const numNodes = Number(reader.readUInt64LEBn());

        // Calculate height and tree size
        this.treeSize = numNodes;
        this.height = Math.ceil(Math.log2(numNodes));

        // Read nodes
        this.nodes = [];
        for (let i = 0; i < numNodes; i++) {
            const hash = reader.read(32);
            const fee = BigInt(reader.readUInt64LEBn().toString());
            const sizeInBytes = BigInt(reader.readUInt64LEBn().toString());

            this.nodes.push({ hash, fee, sizeInBytes });
        }

        // Read number of conflicting nodes
        const numConflictingNodes = Number(reader.readUInt64LEBn());

        // Read conflicting nodes
        this.conflictingNodes = [];
        for (let i = 0; i < numConflictingNodes; i++) {
            const conflictingNode = reader.read(32);
            this.conflictingNodes.push(conflictingNode);
        }
    }

    // Placeholder for root hash calculation - would need merkle tree implementation
    getRootHash(): number[] | null {
        if (this.rootHash) {
            return this.rootHash;
        }

        if (this.nodes.length === 0) {
            return null;
        }

        // For now, return a simple hash of the first node
        // In a complete implementation, this would build a merkle tree
        if (this.nodes.length > 0) {
            this.rootHash = Hash.sha256(this.nodes[0].hash);
            return this.rootHash;
        }

        return null;
    }

    // Utility methods
    getMap(): TxMap {
        const map = new SimpleTxMap();
        for (let i = 0; i < this.nodes.length; i++) {
            map.put(this.nodes[i].hash, BigInt(i));
        }
        return map;
    }

    difference(ids: TxMap): SubtreeNode[] {
        const diff: SubtreeNode[] = [];
        for (const node of this.nodes) {
            if (!ids.exists(node.hash)) {
                diff.push(node);
            }
        }
        return diff;
    }
}
