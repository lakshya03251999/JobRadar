# JobRadar architecture

One email's journey: Gmail, then the worker, a cheap filter, a queue, LLM extraction, validation, the database, and finally the dashboard and reminders. Low-confidence mail goes to a review queue instead of the dashboard, and a reminder is only built for a validated deadline.

## The pipeline

```mermaid
flowchart LR
    subgraph Ingestion
      G[Gmail API\nread-only OAuth]
      W[Ingestion worker\npolls every 5 min]
      F[Rule pre-filter\nkeywords + ATS domains]
      Q[Job queue\nBullMQ+Redis or in-memory]
    end

    subgraph Processing
      L[LLM extractor\nOpenRouter, strict JSON]
      V{Validation\nevidence + confidence}
      DB[(SQLite / Postgres\napplications, events)]
      R[Review queue\nyou confirm or fix]
    end

    subgraph Delivery
      UI[Next.js dashboard\npipeline + deadlines]
      SCH[Reminder scheduler\n24h before deadline]
      TG[Reminder sweep\nlogged, shown on dashboard]
    end

    G --> W --> F --> Q --> L --> V
    V -- confidence >= 0.7 & evidence ok --> DB
    V -- confidence < 0.7 or hallucination --> R
    R -- user confirms --> DB
    DB --> UI
    DB --> SCH --> TG
```

## Why each boundary exists

| Boundary | Reason |
|---|---|
| Rule pre-filter before the LLM | Most inbox mail isn't job-related. Rules are free, the LLM isn't, so reject the obvious noise first. |
| Queue between fetch and extract | Retries and a concurrency cap so a burst never hammers the LLM. With Redis it's also crash-durable; in-memory mode trades that for zero-install local dev. |
| Validation between LLM and DB | The LLM can hallucinate a deadline. Nothing reaches the dashboard until the deadline text is found word-for-word in the email and the confidence clears the bar. |
| Review queue | Low-confidence mail becomes a human decision instead of a silent wrong answer, and each correction can become a future test fixture. |
| Reminder only for validated deadlines | We never nag about a date we aren't sure about. |
