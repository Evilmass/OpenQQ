import { Input } from './form';
import { Select } from './select';

interface PickInputProps {
  id: string;
  value: string;
  onValueChange(value: string): void;
  /** 下拉里的候选项；为空时只显示文本框。 */
  options: string[];
  placeholder?: string;
  /** 下拉框的提示文字，也是它的无障碍名称。 */
  listLabel: string;
  invalid?: boolean;
  describedBy?: string;
  /** 下拉框的宽度类，默认 w-48。 */
  selectClassName?: string;
  /** 下拉框里是否显示当前选中的值。候选项很短、框里已经能看到值时可以关掉，让下拉框只显示提示文字。默认显示。 */
  showSelected?: boolean;
}

/**
 * 文本框加下拉列表：可以直接输入，也可以从列表里选。
 * 浏览器自带的 <datalist> 只会列出和已输入文字匹配的项，框里已经有内容时看起来就像没有列表，所以这里用真正的下拉框。
 */
export function PickInput({ id, value, onValueChange, options, placeholder, listLabel, invalid, describedBy, selectClassName = 'w-48', showSelected = true }: PickInputProps) {
  return <div className="flex gap-2">
    <Input id={id} value={value} placeholder={placeholder} spellCheck={false} className="min-w-0 flex-1 font-mono text-caption" aria-invalid={invalid} aria-describedby={describedBy}
      onChange={event => onValueChange(event.target.value)} />
    {options.length > 0 && <Select aria-label={listLabel} placeholder={listLabel} className={`shrink-0 ${selectClassName}`} value={showSelected && options.includes(value) ? value : ''} onValueChange={onValueChange}
      options={options.map(name => ({ value: name, label: <span className="font-mono text-caption">{name}</span> }))} />}
  </div>;
}
