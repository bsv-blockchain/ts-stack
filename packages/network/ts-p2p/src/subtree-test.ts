import { Subtree, SubtreeNode } from './subtrees.js';
import { Hash, Utils } from '@bsv/sdk';

// Test the Subtree serialization and deserialization
function testSubtreeSerialization() {
    console.log('Testing Subtree serialization and deserialization...');
    
    // Create a new subtree with height 3 (can hold up to 8 nodes)
    const subtree = Subtree.newTree(3);
    
    // Add some test nodes
    const node1Hash = Hash.sha256(Utils.toArray('test1', 'utf8'));
    const node2Hash = Hash.sha256(Utils.toArray('test2', 'utf8'));
    const node3Hash = Hash.sha256(Utils.toArray('test3', 'utf8'));
    
    subtree.addNode(node1Hash, BigInt(1000), BigInt(250));
    subtree.addNode(node2Hash, BigInt(2000), BigInt(500));
    subtree.addNode(node3Hash, BigInt(1500), BigInt(300));
    
    console.log(`Original subtree has ${subtree.length()} nodes`);
    console.log(`Total fees: ${subtree.fees}`);
    console.log(`Total size: ${subtree.sizeInBytes}`);
    
    // Add a conflicting node
    subtree.addConflictingNode(node2Hash);
    console.log(`Added conflicting node, now has ${subtree.conflictingNodes.length} conflicting nodes`);
    
    // Serialize the subtree
    const serialized = subtree.serialize();
    console.log(`Serialized subtree size: ${serialized.length} bytes`);
    
    // Deserialize into a new subtree
    const deserializedSubtree = Subtree.fromBytes(serialized);
    
    console.log(`Deserialized subtree has ${deserializedSubtree.length()} nodes`);
    console.log(`Total fees: ${deserializedSubtree.fees}`);
    console.log(`Total size: ${deserializedSubtree.sizeInBytes}`);
    console.log(`Conflicting nodes: ${deserializedSubtree.conflictingNodes.length}`);
    
    // Test node lookup
    const foundNode = deserializedSubtree.getNode(node1Hash);
    if (foundNode) {
        console.log(`Found node with fee: ${foundNode.fee}`);
    }
    
    // Test node existence
    console.log(`Has node1: ${deserializedSubtree.hasNode(node1Hash)}`);
    console.log(`Has node2: ${deserializedSubtree.hasNode(node2Hash)}`);
    
    // Test serialization of just nodes
    const nodesSerialized = subtree.serializeNodes();
    console.log(`Nodes-only serialization size: ${nodesSerialized.length} bytes`);
    
    console.log('Subtree serialization test completed successfully!');
}

// Test factory methods
function testFactoryMethods() {
    console.log('\\nTesting factory methods...');
    
    // Test newTreeByLeafCount
    const subtree1 = Subtree.newTreeByLeafCount(16); // Must be power of 2
    console.log(`Tree by leaf count (16): height=${subtree1.height}, size=${subtree1.size()}`);
    
    // Test newIncompleteTreeByLeafCount
    const subtree2 = Subtree.newIncompleteTreeByLeafCount(10); // Doesn't need to be power of 2
    console.log(`Incomplete tree by leaf count (10): height=${subtree2.height}, size=${subtree2.size()}`);
    
    console.log('Factory methods test completed!');
}

// Test TxMap functionality
function testTxMap() {
    console.log('\\nTesting TxMap functionality...');
    
    const subtree = Subtree.newTree(2);
    const hash1 = Hash.sha256(Utils.toArray('txmap1', 'utf8'));
    const hash2 = Hash.sha256(Utils.toArray('txmap2', 'utf8'));
    
    subtree.addNode(hash1, BigInt(100), BigInt(50));
    subtree.addNode(hash2, BigInt(200), BigInt(75));
    
    const txMap = subtree.getMap();
    console.log(`TxMap length: ${txMap.length()}`);
    console.log(`Hash1 index: ${txMap.get(hash1)}`);
    console.log(`Hash2 exists: ${txMap.exists(hash2)}`);
    
    // Test difference
    const otherMap = subtree.getMap();
    const hash3 = Hash.sha256(Utils.toArray('txmap3', 'utf8'));
    otherMap.put(hash3, BigInt(2)); // Add a hash that's not in the subtree
    
    const diff = subtree.difference(otherMap);
    console.log(`Difference found ${diff.length} nodes not in the map`);
    
    console.log('TxMap test completed!');
}

// Run all tests
if (import.meta.url === `file://${process.argv[1]}`) {
    testSubtreeSerialization();
    testFactoryMethods();
    testTxMap();
}
