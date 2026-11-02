import poly, { type PolyClientFunction, vari } from 'polyapi';

export const polyConfig: PolyClientFunction = {
  name: 'motdClient',
  context: 'example.sampleWorkflow',
  description:
    'Picks a trained API Function based on mood and returns its content.',
};

export type Mood = 'funny' | 'wise';

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Picks a trained API Function based on mood and returns its content.
 * @param {Mood} mood - "funny" calls the trained joke API Function, "wise" calls the trained advice API Function.
 * @returns {Promise<string>} A joke (funny) or a piece of advice (wise).
 */
export async function motdClient(mood: Mood): Promise<string> {
  if (mood === 'funny') {
    /*
     * jokeApiConfig is SECRET: .get() would throw. .inject() passes an opaque
     * placeholder that the platform resolves server-side — the real value
     * never exists in this code.
     */
    const joke = await poly.example.sampleWorkflow.getRandomJoke(
      vari.example.sampleWorkflow.jokeApiConfig.inject('hostUrl')
    );
    if (
      !isSuccessStatus(joke.status) ||
      !joke.data?.setup ||
      !joke.data?.punchline
    ) {
      throw new Error(`getRandomJoke failed with status ${joke.status}`);
    }
    return `${joke.data.setup} ... ${joke.data.punchline}`;
  }

  /*
   * adviceApiConfig is OBSCURED: .get() returns the real value here; it's only
   * masked from view in Canopy UI, not restricted from code.
   */
  const { hostUrl } =
    (await vari.example.sampleWorkflow.adviceApiConfig.get()) as {
      hostUrl: string;
    };
  const advice = await poly.example.sampleWorkflow.getRandomAdvice(hostUrl);
  if (!isSuccessStatus(advice.status) || !advice.data?.slip?.advice) {
    throw new Error(`getRandomAdvice failed with status ${advice.status}`);
  }
  return advice.data.slip.advice;
}
