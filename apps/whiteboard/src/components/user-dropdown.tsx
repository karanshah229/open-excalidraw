import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useNavigate } from '@tanstack/react-router'
import { LogOut, SlidersHorizontal } from 'lucide-react'
import { useUser } from '../lib/user-context'

export function UserDropdown() {
  const { user, initials, fullName, logout } = useUser()
  const navigate = useNavigate()

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="user-avatar user-avatar-btn"
          title={`User menu for ${fullName}`}
          aria-label={`User menu for ${fullName}`}
        >
          {initials}
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="user-dropdown-content animate-fade-in"
          align="end"
          sideOffset={8}
        >
          <div className="user-dropdown-header">
            <div className="user-dropdown-avatar">{initials}</div>
            <div className="user-dropdown-info">
              <span className="user-dropdown-name">{fullName}</span>
              {user.email && <span className="user-dropdown-email">{user.email}</span>}
            </div>
          </div>

          <DropdownMenu.Separator className="user-dropdown-divider" />

          <DropdownMenu.Item
            className="user-dropdown-item"
            onSelect={() => navigate({ to: '/settings' })}
          >
            <SlidersHorizontal size={14} className="user-dropdown-item-icon" />
            <span>Preferences</span>
          </DropdownMenu.Item>

          <DropdownMenu.Separator className="user-dropdown-divider" />

          <DropdownMenu.Item
            className="user-dropdown-item user-dropdown-item--danger"
            onSelect={() => logout()}
          >
            <LogOut size={14} className="user-dropdown-item-icon" />
            <span>Logout</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
