-- A link between two entries can say that one is a payment of the other
-- (the bank payment of a bill, a customer's deposit for an invoice), and how
-- much of it goes to that entry when it pays several. The entry paid then
-- shows its payments, what is paid and what is left, and carries one of the
-- tags unpaid, partially_paid or paid, which Ledger keeps true as payments
-- are linked and taken off. Entries themselves don't change.
ALTER TABLE journal_entry_relations ADD COLUMN payment_of BIGINT REFERENCES journal_entries (id) ON DELETE RESTRICT;
-- Cents of the payment that go to the entry paid; NULL: all of the payment.
ALTER TABLE journal_entry_relations ADD COLUMN amount BIGINT;
ALTER TABLE journal_entry_relations ADD CONSTRAINT journal_entry_relations_payment CHECK (
    (payment_of IS NULL AND amount IS NULL)
    OR (payment_of IN (entry_id, related_id) AND (amount IS NULL OR amount > 0)));
CREATE INDEX journal_entry_relations_payment_idx ON journal_entry_relations (payment_of) WHERE payment_of IS NOT NULL;
