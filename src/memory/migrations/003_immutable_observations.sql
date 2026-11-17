CREATE TRIGGER snapshots_no_update
BEFORE UPDATE ON snapshots
BEGIN
  SELECT RAISE(ABORT, 'snapshots are immutable');
END;
CREATE TRIGGER snapshots_no_delete
BEFORE DELETE ON snapshots
BEGIN
  SELECT RAISE(ABORT, 'snapshots are immutable');
END;
CREATE TRIGGER claims_no_update
BEFORE UPDATE ON claims
BEGIN
  SELECT RAISE(ABORT, 'claims are immutable');
END;
CREATE TRIGGER claims_no_delete
BEFORE DELETE ON claims
BEGIN
  SELECT RAISE(ABORT, 'claims are immutable');
END;
