import type { Translate } from '@/i18n/use-translate'
import type { BotTemplateCategory } from '../../../../../shared/bots/bot-templates'

export function botTemplateCategoryLabel(category: BotTemplateCategory, t: Translate): string {
  switch (category) {
    case 'coding':
      return t('bots.templates.category.coding', 'Coding')
    case 'releases':
      return t('bots.templates.category.releases', 'Releases & CI')
    case 'support':
      return t('bots.templates.category.support', 'Support & triage')
    case 'planning':
      return t('bots.templates.category.planning', 'Planning & docs')
    case 'content':
      return t('bots.templates.category.content', 'Content & social')
    case 'ops':
      return t('bots.templates.category.ops', 'Ops')
    case 'personal':
      return t('bots.templates.category.personal', 'Personal assistant')
  }
}
