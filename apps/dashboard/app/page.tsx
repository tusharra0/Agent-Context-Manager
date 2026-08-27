import results from '../data/results.json';

import { SanitizedDashboardDatasetV1Schema } from '@acm/hosted-evaluation';

import { experimentMetrics } from '../lib/view-model';

const dataset = SanitizedDashboardDatasetV1Schema.parse(results);

export default function HomePage() {
  return (
    <main>
      <header className="masthead">
        <div className="brand">
          <span className="brandMark" aria-hidden="true">
            A
          </span>
          <div>
            <p className="eyebrow">Agent Context Manager</p>
            <h1>Experiment console</h1>
          </div>
        </div>
        <div className="privacyBadge">
          <span className="statusDot" /> Sanitized aggregates only
        </div>
      </header>

      <section className="hero">
        <p className="eyebrow">Context efficiency, with correctness attached</p>
        <h2>Measure what the agent remembers—not just what you removed.</h2>
        <p className="heroCopy">
          Paired Codex and Claude Code runs compare raw and managed context in
          isolated sandboxes. No source, prompts, tool output, or private
          evidence is published here.
        </p>
      </section>

      <section className="sectionHeader">
        <div>
          <p className="eyebrow">Hosted evaluations</p>
          <h3>Latest experiments</h3>
        </div>
        <p>
          Dataset updated{' '}
          {new Date(dataset.generatedAt).toLocaleString('en-US')}
        </p>
      </section>

      {dataset.experiments.length === 0 ? (
        <section className="emptyState">
          <span className="emptyIndex">00</span>
          <div>
            <h3>No live result published yet.</h3>
            <p>
              The dashboard is ready. Run the authenticated hosted evaluation
              locally, review its correctness gates, then publish its sanitized
              summary.
            </p>
          </div>
        </section>
      ) : (
        <div className="experimentGrid">
          {dataset.experiments.map((experiment) => (
            <article className="experimentCard" key={experiment.experimentId}>
              <div className="cardHeader">
                <div>
                  <p className="eyebrow">
                    {experiment.harness} · {experiment.model}
                  </p>
                  <h3>{experiment.experimentId}</h3>
                </div>
                <span className={`resultBadge ${experiment.status}`}>
                  {experiment.status}
                </span>
              </div>
              <dl className="metrics">
                {experimentMetrics(experiment).map((metric) => (
                  <div key={metric.label}>
                    <dt>{metric.label}</dt>
                    <dd>{metric.value}</dd>
                  </div>
                ))}
              </dl>
              <footer>
                <span>{experiment.repositoryFixture.id}</span>
                <time dateTime={experiment.createdAt}>
                  {new Date(experiment.createdAt).toLocaleDateString('en-US')}
                </time>
              </footer>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
