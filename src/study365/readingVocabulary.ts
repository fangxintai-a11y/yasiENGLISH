import { Rating, review } from "../store/srs";
import type { Progress } from "../store/store";
export function addReadingVocabulary(
  progress: Progress,
  id: string,
  now: number,
  retention = 0.9,
): Progress {
  return {
    ...progress,
    mistakes: [id, ...progress.mistakes.filter((value) => value !== id)].slice(
      0,
      300,
    ),
    cards: {
      ...progress.cards,
      [id]: review(progress.cards[id], Rating.Again, now, retention),
    },
  };
}
