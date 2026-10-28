import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en'
import ru from './ru'

/** Чтобы добавить язык: создайте файл по образцу en.ts и допишите его сюда. */
export const LANGUAGES = { ru: 'Русский', en: 'English' } as const
export type Language = keyof typeof LANGUAGES

const STORAGE_KEY = 'zvon.language'

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && saved in LANGUAGES) return saved as Language
  } catch {
    /* localStorage может быть недоступен */
  }
  return 'ru'
}

void i18n.use(initReactI18next).init({
  resources: { ru: { translation: ru }, en: { translation: en } },
  lng: initialLanguage(),
  fallbackLng: 'ru',
  interpolation: { escapeValue: false }
})

export function setLanguage(lang: Language): void {
  void i18n.changeLanguage(lang)
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    /* ignore */
  }
}

export default i18n
