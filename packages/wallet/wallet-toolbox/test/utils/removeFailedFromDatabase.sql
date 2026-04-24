-- Create a temporary table to hold the record IDs
CREATE TEMPORARY TABLE #BadTxIds (
    transactionId INT
    txid VARCHAR(64)
);

-- Insert IDs from an example table into the temporary table
INSERT INTO #BadTxIds (transactionId, txid)
SELECT transactionId, txid 
FROM transactions
WHERE status != 'completed' and status != 'unproven';

-- Example of further processing or querying the temporary table
SELECT * FROM #TempIDs; -- You might process these IDs in subsequent queries

-- Clean up: Drop the temporary table when done
DROP TABLE #TempIDs;