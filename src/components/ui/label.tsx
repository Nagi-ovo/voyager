import * as React from 'react';

import { cn } from '../../lib/utils';

const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    // oxlint-disable-next-line jsx-a11y/label-has-associated-control -- primitive: consumers supply htmlFor and the control
    <label
      ref={ref}
      className={cn(
        'text-foreground text-sm leading-none font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        className,
      )}
      {...props}
    />
  ),
);
Label.displayName = 'Label';

export { Label };
