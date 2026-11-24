import { Calendar03Icon } from "@hugeicons/core-free-icons";
import { cn } from "cn";
import { useState } from "react";
import type { Matcher } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TimePicker, TimePickerContent, TimePickerInput } from "@/components/reui/time-picker";
import { Icon } from "./icon.tsx";

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** A `YYYY-MM-DD` day as local midnight, or `undefined` when it is blank or no real day. */
function parseDay(value: string): Date | undefined {
  const match = DAY.exec(value);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const date = new Date(year, month, day);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day
    ? date
    : undefined;
}

/** The local calendar day, as `<input type="date">` writes it. */
function formatDay(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

/** Refuses every day before today in the browser's zone. */
export function beforeToday(): Matcher {
  const now = new Date();
  return { before: new Date(now.getFullYear(), now.getMonth(), now.getDate()) };
}

export type DatePickerProps = Readonly<{
  className?: string;
  disabledDays?: Matcher;
  invalid?: boolean;
  /** The visible label's text; the trigger's name is this, then the chosen day. */
  label: string;
  /** `YYYY-MM-DD` in the browser's zone, or `""` once cleared. */
  onChange: (day: string) => void;
  /** `YYYY-MM-DD` in the browser's zone, or `""` for no day. */
  value: string;
}>;

/** One local day from a calendar, in the value format and zone of `<input type="date">`. */
export function DatePicker({
  className,
  disabledDays,
  invalid = false,
  label,
  onChange,
  value,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const selected = parseDay(value);
  const shown = selected?.toLocaleDateString(undefined, { dateStyle: "medium" });
  const pick = (day: string) => {
    onChange(day);
    setOpen(false);
  };
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            aria-invalid={invalid || undefined}
            aria-label={`${label}: ${shown ?? "no day"}`}
            className={cn("w-full justify-between font-normal", className)}
            suppressHydrationWarning
            variant="outline"
          />
        }
      >
        <span
          className={cn("truncate", shown ? undefined : "text-muted-foreground")}
          suppressHydrationWarning
        >
          {shown ?? "Pick a day"}
        </span>
        <Icon className="text-muted-foreground" icon={Calendar03Icon} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto gap-0 p-0">
        <Calendar
          autoFocus
          mode="single"
          onSelect={(date) => pick(date ? formatDay(date) : "")}
          {...(selected === undefined ? {} : { defaultMonth: selected, selected })}
          {...(disabledDays === undefined ? {} : { disabled: disabledDays })}
        />
        {value === "" ? null : (
          <div className="flex justify-end border-t p-1.5">
            <Button onClick={() => pick("")} size="sm" variant="ghost">
              Clear
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * A local date and time in the `YYYY-MM-DDTHH:mm` format of `<input type="datetime-local">`, with
 * no zone of its own. Until both halves are set the value is `YYYY-MM-DDT` or `THH:mm`, which no
 * reader accepts as a time, so the form shows its invalid-time message. Clearing the day clears
 * both halves.
 */
export function DateTimePicker({
  disabledDays,
  invalid = false,
  label,
  onChange,
  value,
}: Omit<DatePickerProps, "className">) {
  const [day = "", time = ""] = value.split("T");
  const join = (nextDay: string, nextTime: string) =>
    nextDay === "" && nextTime === "" ? "" : `${nextDay}T${nextTime}`;
  return (
    <div aria-label={label} className="flex gap-3" role="group">
      <DatePicker
        className="flex-1"
        invalid={invalid}
        label={`${label} day`}
        onChange={(nextDay) => onChange(nextDay === "" ? "" : join(nextDay, time))}
        value={day}
        {...(disabledDays === undefined ? {} : { disabledDays })}
      />
      <TimePicker
        aria-label={`${label} time`}
        invalid={invalid}
        onValueChange={(nextTime) => onChange(join(day, nextTime ?? ""))}
        value={time.slice(0, 5) || null}
      >
        <TimePickerInput className="w-32" />
        <TimePickerContent />
      </TimePicker>
    </div>
  );
}
