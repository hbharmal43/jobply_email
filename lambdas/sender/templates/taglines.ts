/**
 * Rotating one-line header taglines (Zomato-notification style) shown in the
 * yellow header bar under the logo. Deterministically picked per send via
 * pickTagline() — no DB state needed, and the same recipient won't see the
 * same line twice in a row across different days.
 */
export const TAGLINES: string[] = [
  "Your dream job isn't going to apply to itself.",
  'Recruiters are scrolling. Are you?',
  'Somewhere, a hiring manager is refreshing their inbox for someone like you.',
  '3 new matches just landed. No pressure.',
  'Your resume called. It wants some action.',
  'Monday motivation: one more application, one step closer.',
  'Plot twist: the job you want is one click away.',
  "Interviews don't schedule themselves. Well, actually...",
  "Your future coworkers don't know you exist yet. Let's fix that.",
  "Job hunting is a numbers game. Let's improve your odds.",
  "That 'Easy Apply' button isn't going to press itself.",
  "Somewhere between coffee #1 and coffee #2, apply to something.",
  "Your career glow-up starts with today's applications.",
  'Recruiters love consistency. So do we.',
  "The extension's ready. Are you?",
  'Small steps, big offers.',
  "You're closer to 'you're hired' than you think.",
  'Today\'s forecast: 100% chance of new opportunities.',
  "Your next 'yes' is hiding in today's matches.",
  'Job search fatigue is real. Let us do the heavy lifting.',
  'One application away from a very different Monday.',
  'Nobody regrets hitting apply. They regret not hitting apply.',
  "Your LinkedIn profile called. It's jealous of your Jobply activity.",
  'Good things come to those who apply.',
  'Less scrolling, more applying.',
  'The best time to apply was yesterday. The second best is now.',
  'Consistency beats motivation. Show up today.',
  "Every 'no' gets you closer to your 'yes'.",
  "Your future self is counting on today's you.",
  "Fresh matches, zero effort. That's the Jobply way.",
  'Interviews are just conversations with better stakes.',
  "You've got this. We've got the shortcuts.",
  "Not all heroes fill out application forms manually. You don't have to either.",
  'The grind is real. So is the extension that skips it.',
  'A little progress each day adds up to big results.',
  "Your next opportunity doesn't care what day it is. Neither should you.",
  'Applications submitted > applications planned.',
  "Somebody's inbox is missing your resume.",
  "Turn 'maybe later' into 'done' today.",
  "You didn't come this far to stop applying now.",
  'Great things never came from comfort zones or unfinished profiles.',
  'The job market moves fast. So does Jobply.',
  'Fortune favors the applied.',
  'Your competition is applying right now. Just saying.',
  'Behind every offer letter is a bunch of applications that came first.',
  "Don't let a good match go cold.",
  'New week, new matches, same goal: get hired.',
  "You're one 'apply' away from a very good story.",
  "Your career doesn't pause for procrastination.",
  'Job searching is a marathon. We packed you snacks.',
  'The extension autofills. You just aim and click.',
  'This is your sign to check your matches.',
  "Somebody has to get this job. Might as well be you.",
  "Applications don't submit themselves. Oh wait, ours kind of do.",
  'The early applicant gets the interview.',
  "Your resume deserves more eyeballs. Let's get it some.",
  'Slow and steady wins the job search.',
  'You + Jobply + 5 minutes = progress.',
  'The best career moves start with the smallest clicks.',
  "Opportunity is knocking. Don't let it go to voicemail.",
  "Your job search glow-up is one dashboard visit away.",
  'Big offers start with small habits.',
  "Recruiters can't find you if you don't apply.",
  "Let's turn today's coffee break into a job search win.",
  'New day, new matches, zero excuses.',
  "The only bad application is the one you didn't send.",
  "Somewhere, your next manager is writing a job description right now.",
  'Trade fifteen minutes of scrolling for fifteen minutes of applying.',
  "Your dashboard has new matches. They won't wait forever.",
  "Momentum is a job seeker's best friend. Keep yours going.",
  "You're one login away from your next big move.",
  'Getting hired starts with getting started.',
  "Let today's application be the one that changes everything.",
  'Job offers love a full pipeline. Keep yours stocked.',
  'The interview you want starts with the application you send.',
  "There's no elevator to your dream job. Just the apply button.",
  "Your future job title is waiting on today's action.",
  'Progress, not perfection. Especially in job hunting.',
  "You've got matches. We've got your back.",
  'A closed tab never landed anyone a job.',
  'One more application today. Future you will thank you.',
  'Great resumes deserve great follow-through.',
  "Job hunting hits different with autofill on your side.",
  'Somewhere out there, a company needs exactly what you offer.',
  "Keep applying. The right 'yes' is worth the wait.",
  "You're not behind. You're just getting started.",
  'This could be the week it finally clicks.',
  'New matches just dropped. Yes, like a playlist.',
  "You bring the skills. We'll handle the paperwork.",
  "Don't just dream about the offer. Apply for it.",
  "Every application is a lottery ticket you actually earned.",
  'Consistency is the real hack to getting hired.',
  "Somebody's about to read your resume for the first time. Make it count.",
  "Job searching solo is hard. Good thing you're not doing it solo.",
  'Your next role is closer than your last coffee refill.',
  "The best applicants aren't the loudest. They're the most consistent.",
  "Today's a great day to stop 'thinking about applying'.",
  'Your dashboard misses you. Also, it has new matches.',
  'One click closer to your next chapter.',
  "Let's find the job that finds you back.",
];

/** Simple deterministic string hash (djb2 variant) — good enough for even index spread. */
function hashSeed(seed: string): number {
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash * 33) ^ seed.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Deterministically picks a tagline from the seed (recipient + template +
 * date) so the same person/template combo gets a stable line within a day,
 * but a different one most other days, without any DB state.
 */
export function pickTagline(seed: string): string {
  const index = hashSeed(seed) % TAGLINES.length;
  return TAGLINES[index];
}
