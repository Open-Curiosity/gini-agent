# Ideas

Open questions and approaches that are too detailed for the whitepaper but worth tracking. The whitepaper says *what* has to be true; this doc is where *how* gets worked out.

Treat anything here as in-flight. Things that get decided graduate into ADRs or focused docs. Things that get rejected stay here as a record of what didn't work.

## Skill evaluation: how does the agent know a skill works?

The second gap in the whitepaper — "what the agent learns, sticks" — depends on the agent being able to evaluate its own skills. Re-running a skill against the same situation is the obvious test, but most real tasks aren't safely repeatable:

- **Reversible tasks** (running a query, generating a report). Re-run and compare outputs.
- **Irreversible tasks** (sending a message, making a payment, deleting a file, calling an external API with side effects). Can't be re-run safely.
- **Probabilistic tasks** (anything involving an LLM). One run isn't enough to know if a skill is reliable; you need outcomes across many runs.

Open questions:

- How does a skill declare which evaluation strategy applies to it?
- For irreversible skills, what counts as evidence that the skill worked? Schema-checking the output? A separate validation step? Human-in-the-loop confirmation on the first N runs?
- How does the agent decide a skill has failed enough times to need updating, vs. having a bad run?
- Where does evaluation evidence live, and what does the agent do with it on the next run?

This is the load-bearing question for self-improvement. Without a real answer, "the agent learns from itself" is just a marketing claim.
