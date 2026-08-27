# The forensics table MariaDB doesn't have

> MySQL session forensics — which connected session holds a binlog_format or sql_log_bin override — is a two-table JOIN on performance_schema.variables_by_thread and threads. On MariaDB that query dies with ERROR 1146: the table doesn't exist, whether performance_schema is ON or OFF, because MariaDB's performance_schema never implemented it. And under MariaDB's OFF default, the tables it does have answer empty instead of erroring — so a ported runbook fails both ways, at exactly the mid-incident moment it's reached for.

Observed &mdash; live for this note, on stock mariadb:11.4 (11.4.13) in both switch positions, and reproduced on the latest MariaDB image. The flavor-precondition sentence shipped in sluice v0.132.1's error-remedy text.

## The query and the error

MySQL runbooks lean on performance_schema for session forensics, and a tool's own error messages can too: when sluice's binlog CDC halts on statement-logged DML (a SUPER session's SET SESSION binlog_format=STATEMENT slipping past the global preflight), the printed remedy is the standard two-table JOIN &mdash; variables_by_thread against threads &mdash; to name the session holding the override. Ported to MariaDB, that query does not degrade; it detonates:

    ERROR 1146 (42S02): Table 'performance_schema.variables_by_thread' doesn't exist

## Two flavor differences, stacked

First &mdash; and this is the half we had wrong until we ran it &mdash; the absence is not the OFF default at work; it's the table set. MariaDB's performance_schema implements an older, smaller surface (81 tables on 11.4): variables_by_thread, a MySQL 5.7 addition, is not among them with performance_schema ON or OFF &mdash; verified in both positions, and still absent on the latest MariaDB image. The only per-thread variables table MariaDB carries is user_variables_by_thread, which holds user-defined @variables &mdash; a different thing entirely. So the reflex fix, enable performance_schema in server config and restart, does not make this query run on MariaDB at all.

Second, the OFF default (MySQL defaults ON, MariaDB OFF) changes how the tables MariaDB does have fail. OFF doesn't drop them: threads still exists and simply answers zero rows &mdash; it reports live sessions the moment the switch is ON. So a ported probe fails split by table: the tables MariaDB never implemented hard-error with 1146, and the tables it has silently report nothing under the default. The second failure is arguably worse &mdash; a monitoring query that returns &ldquo;no sessions found&rdquo; gets believed.

## The operational shape

Both failures fire at the worst moment. Session forensics is mid-incident tooling &mdash; it's reached for when replication has already halted, often straight out of an error message's own remedy text, which makes that remedy untested code on one flavor of the family until someone runs it there. On MariaDB the practical fallback is SHOW PROCESSLIST plus interrogating candidate sessions one by one; there is no variables_by_thread to JOIN against.

## The transferable lesson

A query's precondition set differs by flavor even where its syntax parses identically on both. A runbook, a dashboard, a health probe, or an error-message remedy is a claim about a specific flavor's catalog, and it only holds where it has actually been run: absent-vs-empty is the difference between a runbook that crashes and one that reports nothing &mdash; and MariaDB hands you both at once, split by table. The companion note is the status-statement version of the same trap: SHOW REPLICA STATUS parses on both engines and enumerates a different set on each. Dialect traps are not confined to DDL &mdash; they extend to every diagnostic question you ask.

## Primary sources

- MariaDB documentation &mdash; Performance Schema overview &mdash; disabled by default, and MariaDB's own table list.

- MySQL reference &mdash; performance_schema system-variable tables &mdash; variables_by_thread, the MySQL 5.7 addition the runbook leans on.

- Live verification for this note: throwaway mariadb:11.4 and mariadb:latest containers, performance_schema ON and OFF &mdash; the 1146 error in every position, threads empty under OFF and populated under ON.

- sluice v0.132.1 changelog &mdash; the remedy-text precondition for the MariaDB flavor.

- Related field note: The replica you can't detect is the replica that loses your writes &mdash; the same lesson asked of a status statement instead of a catalog table.

---
Canonical page: https://sluicesync.com/field-notes/mariadb-performance-schema-absent/ · Full docs index: https://sluicesync.com/llms.txt
