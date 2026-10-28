/** Встроенный набор эмодзи для пикера (без внешних зависимостей). */
export interface EmojiGroup {
  id: string
  icon: string
  ru: string
  en: string
  items: string[]
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
// Делим по графемам, чтобы не разрывать составные эмодзи (✌️, 😮‍💨).
const s = (str: string): string[] => Array.from(graphemes.segment(str.replace(/\s+/g, '')), (x) => x.segment)

export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    id: 'smileys',
    icon: '😀',
    ru: 'Смайлы',
    en: 'Smileys',
    items: s('😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘😋😛😜🤪😝🤑🤗🤭🤫🤔🤐🤨😐😑😶😏😒🙄😬😮‍💨🤥😌😔😪🤤😴😷🤒🤕🤢🤮🥵🥶🥴😵🤯🤠🥳😎🤓🧐😕😟🙁😮😯😲😳🥺😦😧😨😰😥😢😭😱😖😣😞😓😩😫🥱😤😡😠🤬😈👿💀☠️💩🤡👻👽🤖')
  },
  {
    id: 'gestures',
    icon: '👍',
    ru: 'Жесты',
    en: 'Gestures',
    items: s('👍👎👌🤌🤏✌️🤞🤟🤘🤙👈👉👆👇☝️✋🤚🖐️🖖👋🤝👏🙌👐🤲🙏✍️💪🦾🧠👀👁️👅👄')
  },
  {
    id: 'hearts',
    icon: '❤️',
    ru: 'Символы',
    en: 'Symbols',
    items: s('❤️🧡💛💚💙💜🖤🤍🤎💔❣️💕💞💓💗💖💘💝💯💢💥💫💦💨🕳️💬💭💤✅❌❓❗⚠️🔥✨⭐🌟🎉🎊🏆🥇🎯💡🔔🎵🎶➕➖✖️')
  },
  {
    id: 'activities',
    icon: '🎮',
    ru: 'Игры',
    en: 'Activities',
    items: s('🎮🕹️🎲♟️🧩🎯🎳⚽🏀🏈⚾🎾🏐🏉🎱🏓🏸🥊🥋⛳🎣🎿🛹🚴🏎️🏁🎬🎧🎤🎸🥁🎹📺💻🖥️⌨️🖱️📱📷')
  },
  {
    id: 'food',
    icon: '🍕',
    ru: 'Еда',
    en: 'Food',
    items: s('🍏🍎🍐🍊🍋🍌🍉🍇🍓🍒🍑🥭🍍🥥🥝🍅🥑🍆🥔🥕🌽🌶️🥒🥦🧄🧅🍄🥜🍞🥐🥖🧀🥚🍳🥓🥩🍗🍖🌭🍔🍟🍕🥪🌮🌯🥗🍝🍜🍲🍣🍤🍦🍩🍪🎂🍰🍫🍬🍿☕🍵🧃🥤🍺🍻🥂🍷🥃🍸')
  },
  {
    id: 'nature',
    icon: '🐱',
    ru: 'Природа',
    en: 'Nature',
    items: s('🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🙈🙉🙊🐔🐧🐦🦆🦅🦉🐺🐗🐴🦄🐝🐛🦋🐌🐞🐢🐍🦖🐙🦀🐬🐳🦈🌵🌲🌴🌱🍀🍁🍂🌷🌹🌻🌞🌝🌚🌙⭐🌈☀️⛅☁️🌧️⛈️❄️☃️🌊')
  }
]

/** Сообщение только из эмодзи (до 6 штук) показывается крупно. */
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u

export function isEmojiOnly(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || !EMOJI_ONLY.test(trimmed)) return false
  if (/^[\d#*\s]+$/.test(trimmed)) return false // цифры тоже Emoji_Component
  const count = Array.from(trimmed.matchAll(/\p{Extended_Pictographic}/gu)).length
  return count > 0 && count <= 6
}
