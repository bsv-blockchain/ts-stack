## Transaction Negotiation

Transaction negotiation is a process of sending a partial transaction back and forth between two parties, an initiator and a counterparty, to negotiate a final version of the transaction. The initiator creates a partial transaction that contains enough information for the counterparty to know what is being requested. Then the counterparty can add their information to the transaction and send it back. There can be several rounds of communication before finalizing and signing the transaction.

The data included in this structure include the partial transaction and other data to supplement it.

A thread ID is included to link a transaction to previous versions.
Ancestors are included so both parties can calculate fees, verify signatures, and see any relevant historical information.
Fee information can be included so both parties can adjust to the same tx fee rate.
An expiry is included so both parties know when the other will no longer want to continue the negoatiation.
A timestamp is included so both parties know when each update was made.
Reply to information is included so that each party knows where to send responses.
Previous methods of interacting with another wallet have lacked the ability to do anything more than simple bitcoin payments and are not really peer to peer. Including a full transaction structure with ancestors allows much more dynamic and complex interactions like negotiating transfer and exchange of Tokenized tokens.

Since this method establishes "reply to" information, rather than just returning results via REST API, followup information can be provided to the other party when it becomes available, like merkle proofs and token settlements. This also allows requests to be responded to directly by users rather than needing the service host to automatically respond to all requests.


A full explanation of the protocol can be found here

https://github.com/tokenized/pkg/blob/master/bsvalias/NegotiationTransaction.md