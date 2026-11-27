import type { BotTemplate } from '../bot-templates'

export const BOT_TEMPLATES_CONTENT: readonly BotTemplate[] = [
  {
    id: 'content-repurposer',
    category: 'content',
    name: 'Content repurposer',
    line: 'Turns one link, note or transcript into a post for each channel you use.',
    firstChat:
      'Asks which channels you post on and for two or three posts you liked, then turns the next link, notes or transcript you send into a draft for each channel. It never posts.',
    mascot: 'K2',
    watches: 'Links, notes and transcripts you send it',
    does: 'Drafts an X post or thread, a LinkedIn post, carousel slides or a short-video script from one source, in your voice. Never posts.',
    reports: 'Here, when you send it something',
    connectors: ['slack'],
    schedules: [],
    events: [
      {
        id: 'content-shared',
        name: 'When someone posts in a content channel: draft posts from it',
        source: 'slack',
        event: 'message',
        prompt:
          'Someone posted in the content channel. If the message has no link, notes or transcript to work from, stop without posting. Otherwise draft a post for each of my owner’s channels with the channel-formats and brand-voice skills and post the drafts here. Never post them anywhere else.'
      }
    ],
    skills: ['brand-voice', 'channel-formats'],
    example: [
      'From your podcast notes: a LinkedIn post (5 lines) and an X thread (6 posts).',
      'Carousel: 7 slides, hook on slide 1, caption separate.'
    ]
  },
  {
    id: 'content-plan',
    category: 'content',
    name: 'Weekly content plan',
    line: 'Plans the week’s posts, then drafts each one on its day.',
    firstChat:
      'Asks which channels you post on, how often, and the three or four themes you post about, then writes this week’s plan. It never posts.',
    mascot: 'J1',
    watches: 'Your themes, your ideas and what you tell it worked',
    does: 'Plans the week’s posts by channel and theme in a calendar file, then drafts each day’s posts that morning. Never posts.',
    reports: 'Here, Mondays at 9 AM and weekdays at 10 AM',
    connectors: [],
    schedules: [
      {
        id: 'weekly-plan',
        when: 'Mondays at 9 AM',
        what: 'This week’s plan',
        rrule: '0 9 * * 1',
        prompt:
          'Write this week’s content plan in content-calendar.md in your folder: one line per post with its day, channel, theme and hook, spread across my owner’s channels and themes. Use kept ideas from the idea bank first. Post the plan here. Never post anything anywhere else.'
      },
      {
        id: 'daily-drafts',
        when: 'Weekdays at 10 AM',
        what: 'Today’s posts',
        rrule: '0 10 * * 1-5',
        prompt:
          'Find today’s posts in content-calendar.md and draft each one with the channel-formats and brand-voice skills, ready to copy. If nothing is planned for today, say so in one line. Never post anything.'
      }
    ],
    events: [],
    skills: ['brand-voice', 'channel-formats', 'idea-bank'],
    example: [
      'This week: 3 LinkedIn posts, 2 carousels, 1 newsletter, across your 3 themes.',
      'Today’s LinkedIn draft is ready: 6 lines, hook first.'
    ]
  },
  {
    id: 'idea-scout',
    category: 'content',
    name: 'Idea scout',
    line: 'Five post ideas each weekday, from sources you trust.',
    firstChat:
      'Asks for your niche and five to ten sources you trust, such as sites, newsletters and communities, then brings this morning’s ideas, each with a hook and its link.',
    mascot: 'N1',
    watches: 'The websites and communities you name',
    does: 'Finds what’s new in your niche, picks five ideas with a hook and a source link each, and keeps the ones you like in an idea bank.',
    reports: 'Here, weekdays at 8 AM',
    connectors: [],
    schedules: [
      {
        id: 'morning-ideas',
        when: 'Weekdays at 8 AM',
        what: 'Five post ideas',
        rrule: '0 8 * * 1-5',
        prompt:
          'Check the sources my owner named for what is new since your last run. Pick up to five post ideas for their niche with the idea-bank and brand-voice skills, each with a one-line hook and its source link, and skip ideas already in the bank. Post them here, numbered, and add the ones my owner keeps to the bank.'
      }
    ],
    events: [],
    skills: ['idea-bank', 'brand-voice'],
    example: [
      '1. “The pricing page test nobody runs” (from a founder’s thread, linked).',
      '5 ideas today, 2 skipped as already in your bank.'
    ]
  }
]
