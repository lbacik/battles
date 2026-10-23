'use client';

import { formatSavedAt } from '../lib/store';
import type { BattleEntry } from '../lib/battles';

interface BattlesListProps {
  battles: BattleEntry[];
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
}

// The Battles list: every committed turn is saved, so reloading the page
// mid-battle and choosing the battle here resumes the identical state.
// Finished battles stay on the list as read-only and can be deleted.
export default function BattlesList({ battles, onResume, onDelete }: BattlesListProps) {
  return (
    <section className="battles" data-testid="battles-list" aria-label="Battles">
      <span className="eyebrow">PÓLIS · BATTLES</span>
      <h2>Battles</h2>
      {battles.length === 0 ? (
        <p className="empty-battles" data-testid="empty-battles">
          No battles yet. Start a battle from a saved scenario and every committed turn is saved
          here.
        </p>
      ) : (
        <ul className="battle-list">
          {battles.map((entry) => {
            const finished = entry.status !== 'ongoing';
            return (
              <li
                key={entry.id}
                data-testid="battle-row"
                data-battle-id={entry.id}
                data-status={entry.status}
              >
                <div>
                  <div className="title" data-testid="battle-row-title">
                    {entry.title}
                  </div>
                  <div className="meta" data-testid="battle-row-meta">
                    {finished ? 'Finished' : 'In progress'} · {entry.status} · Turn{' '}
                    {entry.turnNumber ?? '—'} · Last saved {formatSavedAt(entry.updatedAt)}
                  </div>
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="btn-secondary"
                    data-testid={finished ? 'view-battle' : 'resume-battle'}
                    data-battle-id={entry.id}
                    onClick={() => onResume(entry.id)}
                  >
                    {finished ? 'View' : 'Resume'}
                  </button>
                  <button
                    type="button"
                    className="btn-quiet btn-danger"
                    data-testid="delete-battle"
                    data-battle-id={entry.id}
                    onClick={() => onDelete(entry.id)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
