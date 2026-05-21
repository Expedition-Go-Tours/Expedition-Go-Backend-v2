import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Input from '../Input';

describe('Input', () => {
  it('should render input element', () => {
    render(<Input />);
    
    const input = screen.getByRole('textbox');
    expect(input).toBeInTheDocument();
  });

  it('should render with placeholder', () => {
    render(<Input placeholder="Enter text" />);
    
    expect(screen.getByPlaceholderText('Enter text')).toBeInTheDocument();
  });

  it('should render with value', () => {
    render(<Input value="test value" onChange={() => {}} />);
    
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('test value');
  });

  it('should call onChange when typing', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    
    render(<Input onChange={onChange} />);
    
    const input = screen.getByRole('textbox');
    await user.type(input, 'test');
    
    expect(onChange).toHaveBeenCalled();
  });

  it('should render with error state', () => {
    render(<Input error={{ message: 'Error message' }} />);
    
    const input = screen.getByRole('textbox');
    expect(input).toHaveClass('border-red-300');
  });

  it('should render without error state', () => {
    render(<Input />);
    
    const input = screen.getByRole('textbox');
    expect(input).not.toHaveClass('border-red-300');
    expect(input).toHaveClass('border-slate-300');
  });

  it('should render as disabled', () => {
    render(<Input disabled />);
    
    const input = screen.getByRole('textbox');
    expect(input).toBeDisabled();
    expect(input).toHaveClass('disabled:bg-slate-50');
  });

  it('should render with different types', () => {
    const { rerender } = render(<Input type="email" />);
    expect(screen.getByRole('textbox')).toHaveAttribute('type', 'email');
    
    rerender(<Input type="password" />);
    const passwordInput = document.querySelector('input[type="password"]');
    expect(passwordInput).toBeInTheDocument();
    
    rerender(<Input type="number" />);
    const numberInput = document.querySelector('input[type="number"]');
    expect(numberInput).toBeInTheDocument();
  });

  it('should apply custom className', () => {
    render(<Input className="custom-class" />);
    
    const input = screen.getByRole('textbox');
    expect(input).toHaveClass('custom-class');
  });

  it('should forward ref', () => {
    const ref = { current: null };
    render(<Input ref={ref} />);
    
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  it('should have focus styles', () => {
    render(<Input />);
    
    const input = screen.getByRole('textbox');
    expect(input).toHaveClass('focus:outline-none');
    expect(input).toHaveClass('focus:ring-2');
  });
});
