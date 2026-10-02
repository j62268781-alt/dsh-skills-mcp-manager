/**
 * The filter row: search box plus the project switch.
 *
 * One row: search on the left, project selector on the right. A hand-typed path
 * is a separate mode, entered from the dropdown and left via "选工作区".
 */
import { HINTS } from './form.js'

/** Build the filter row. */
export function filterRow({ h, query, onQuery, project, projectChoices = [], customProject = false, onCustomProject, onProject, placeholder }) {
  const search = h('div', { className: 'smp-search', key: 'search' }, [
    h('span', { className: 'smp-searchIcon', key: 'i' }, h('svg', {
      width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
    }, h('path', {
      d: 'M7 12a5 5 0 100-10 5 5 0 000 10zm3.5-1.5L14 14',
      stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
    }))),
    h('input', {
      className: 'smp-searchInput',
      key: 'in',
      placeholder,
      value: query,
      onChange: (event) => onQuery(event.target.value),
    }),
  ])

  const picker = customProject
    ? h('input', {
        className: 'smp-projectInput',
        key: 'custom',
        placeholder: '项目绝对路径',
        title: '项目级层显示这个路径下的条目',
        value: project,
        onChange: (event) => onProject(event.target.value),
      })
    : h('select', {
        className: 'smp-projectSelect',
        key: 'project',
        'data-placeholder': String(project === ''),
        title: '选择项目（来自 DSH 的工作区）',
        value: projectChoices.some(([path]) => path === project) ? project : '',
        onChange: (event) => {
          const value = event.target.value
          if (value === '__custom__') { onCustomProject(true); return }
          onCustomProject(false)
          onProject(value)
        },
      }, [
        h('option', { value: '', key: 'none' }, HINTS.project),
        ...projectChoices.map(([path, title]) => h('option', { value: path, key: path }, title)),
        h('option', { value: '__custom__', key: 'custom' }, '自定义路径…'),
      ])

  const children = [search, picker]
  if (customProject) {
    children.push(h('button', {
      className: 'smp-button', 'data-variant': 'outline', key: 'back',
      onClick: () => onCustomProject(false),
    }, '选工作区'))
  }
  return h('div', { className: 'smp-filterRow', key: 'filter' }, children)
}
